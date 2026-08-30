// Pi harness driver (#1063): hosts a pi coding-agent session in-process via
// the pi SDK and translates its event stream into the platform's existing
// claude-stream-json-shaped contract (see drivers/pi-translate.mjs for the
// load-bearing consumers).
//
// Differences from the claude driver, by design:
//  - In-process SDK, no subprocess: errors are API-shaped (classifyPiError),
//    a guest OOM kills the daemon itself (the CP sees the dead session).
//  - The resume handle is the pi session FILE PATH under
//    ~/.pi/agent/sessions/ (SessionManager.open takes a path); it lives on
//    the workspace volume, so resume survives VM destroy.
//  - Cost: sdk.result.total_cost_usd must be session-ROW-cumulative
//    (AccrueAgentSessionCost banks GREATEST-diffs), while pi's
//    SessionStats.cost is session-FILE-cumulative — a resumed file carries
//    prior turns' cost. The baseline captured at start bridges the two.
//  - Results are EVENT-driven, not promise-driven: `prompt()` resolves
//    immediately when the SDK queues a followUp mid-stream, so a per-promise
//    result would fire mid-run. Instead each `agent_end` cycle emits one
//    sdk.result and `agent_settled` drives idle/finish — the SDK's own idea
//    of "a run finished" and "nothing left to do".
//  - Permission gate: an inline extension's blocking `tool_call` handler
//    replaces canUseTool over the SAME pending map + HTTP decision endpoint.
//    The SDK never forwards the abort signal into extension handlers, so
//    interrupt() must cancel pending gate promises itself or abort() would
//    deadlock behind them.
//  - Platform tools ride the MCP → pi bridge (#1065): every mcp_servers
//    entry surfaces as `mcp__<slug>__<tool>` custom tools, and unattended
//    runs additionally get native sleep/park tools. The `pi` daemon cap
//    implies the bridge — 0.7.0 (driver without bridge) never shipped.

import { randomUUID } from 'node:crypto'
import { resolve as pathResolve } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  resolveCliModel,
} from '@earendil-works/pi-coding-agent'
import {
  assistantPayload,
  classifyPiError,
  initPayload,
  lastAssistantText,
  mapEffort,
  partialPayload,
  resultPayload,
  sumAssistantUsage,
  toolResultsPayload,
  turnErrorMessage,
  usagePayload,
} from './pi-translate.mjs'
import { buildBridgedTools } from './mcp-bridge.mjs'
import { buildRunTools } from './pi-run-tools.mjs'
import { evaluateToolPolicy } from './tool-policy.mjs'
import { providerForModel } from './pi-provider.mjs'

// Belt only, and deliberately NOT kept in lockstep with state.PiModels[0] —
// that is now z-ai/glm-5.2 (lyceum), and hardcoding a second vendor's model as
// the daemon's last resort would make the belt itself unrunnable on a
// nebius-only deployment. The CP resolves empty models to the agent/catalog
// default before the spec reaches this driver, so this only fires for a direct
// POST to the daemon. If the VM's catalog does not list it, provider
// resolution below fails loudly rather than guessing.
//
// A GATEWAY SLUG since #1193, matching what the catalog is keyed by: models.json
// now names the platform gateway as every provider endpoint, and the gateway
// accepts slugs only — the vendor's own id (Qwen/Qwen3-235B-A22B-Instruct-2507)
// would 404 as an unknown model.
const DEFAULT_PI_MODEL = 'qwen/qwen3-235b-instruct'

// The permission modes this harness can host. Exported so the server's driver
// registry (drivers/registry.mjs) can enforce the same set at session create
// and on the pre-seed stub — a mode accepted there and rejected here would 200
// the request and then kill the session when construction runs (#1160 review).
export const SUPPORTED_PERMISSION_MODES = new Set(['default', 'bypassPermissions'])

// createPiDriver constructs the driver asynchronously (the pi SDK's session
// creation is async, unlike claude's query()). Throws with .status for
// client-caused failures; the caller owns not publishing a half-built session.
export async function createPiDriver(s, spec, h) {
  const home = process.env.HOME || '/home/agent'
  const cwd = spec.cwd || home
  const agentDir = pathResolve(home, '.pi/agent')

  // The daemon launch sources zwrmd-env.sh (image ENV, since #1347) and
  // zwrmd-agent-env.sh (boot config) — but NOT pi-env.sh, so the profile.d
  // export from #1062 still never reaches this process. Set it before any pi
  // machinery runs (it also covers `pi` CLI children spawned by tools).
  process.env.PI_SKIP_VERSION_CHECK = '1'
  // The pi CLI entry sets this for its children; the SDK-embedded path does
  // not. Without it, a login shell spawned by this session's bash tool
  // (`bash -l`, `su - agent`) re-enters the login profile and execs an
  // interactive `pi --continue`, wedging the tool call (#1064 review).
  process.env.PI_CODING_AGENT = 'true'
  // Per-session env rides the daemon process: the daemon hosts one session
  // at a time and pi's tools (bash, …) inherit process.env. HOME is skipped —
  // overriding it would desynchronize the resume jail from where the SDK
  // actually writes session files.
  for (const [k, v] of Object.entries(spec.env || {})) {
    if (k === 'HOME') continue
    process.env[k] = v
  }

  let mode = spec.permission_mode || 'bypassPermissions'
  if (!SUPPORTED_PERMISSION_MODES.has(mode)) {
    const e = new Error(`the pi harness supports permission modes 'default' and 'bypassPermissions', not '${mode}'`)
    e.status = 400
    throw e
  }


  // Resume handle = session file path. Jail it to pi's sessions dir: the CP
  // round-trips what an earlier init event reported, but the daemon is the
  // last line against a tampered value pointing at an arbitrary file.
  let sessionManager
  if (spec.resume_sdk_session_id) {
    const sessionsRoot = pathResolve(agentDir, 'sessions')
    const p = pathResolve(spec.resume_sdk_session_id)
    if (p !== sessionsRoot && !p.startsWith(sessionsRoot + '/')) {
      const e = new Error('resume handle is not a pi session file')
      e.status = 400
      throw e
    }
    try {
      sessionManager = SessionManager.open(p)
    } catch (err) {
      // A corrupt/unparseable session file is a client-state problem, not a
      // daemon fault. (A MISSING file silently starts fresh — SDK behavior.)
      const e = new Error(`resume failed: ${err?.message || err}`)
      e.status = 400
      throw e
    }
  } else {
    sessionManager = SessionManager.create(cwd)
  }

  // The providers + catalog come from the platform-seeded
  // ~/.pi/agent/models.json (#1075) — pi is EU-models-only; Anthropic
  // models are claude-harness-exclusive.
  //
  // The provider follows the MODEL (#1142): the catalog spans vendors, and the
  // same file names the owner of each model id. A hardcoded provider sends a
  // second vendor's model to the first vendor's endpoint and 404s (#1149).
  const modelRuntime = await ModelRuntime.create()
  const piModel = spec.model || DEFAULT_PI_MODEL
  // Refuse rather than fall back to a fixed provider. pi does NOT reject a
  // model that is absent from the provider it is handed: resolveCliModel calls
  // buildFallbackModel, which clones a model from that provider and overwrites
  // its id, so the request goes to the WRONG vendor and returns a bodyless 404.
  // The session then ends stop_reason=error with zero tokens — nothing
  // throws, so the `!resolved.model` guard below cannot see it. Since #1363
  // that turn at least lands as an error result instead of an empty
  // subtype=success, but it is still a wrong-vendor request the user cannot
  // diagnose. That is #1149 exactly, so a best-effort default here would
  // reintroduce the bug this file exists to fix.
  //
  // Unattributable means the VM's catalog and the caller disagree: a truncated
  // or unreadable models.json, or a model the control plane knows and this
  // (older) image does not. Both are real conditions that want a loud, specific
  // error naming the workspace restart that fixes them.
  const piProvider = providerForModel(agentDir, piModel)
  if (!piProvider) {
    const e = new Error(
      `model ${piModel} is not in this VM's catalog (~/.pi/agent/models.json); ` +
        'restart the workspace VM to pick up the current catalog',
    )
    e.status = 400
    throw e
  }
  const resolved = resolveCliModel({
    cliProvider: piProvider,
    cliModel: piModel,
    modelRuntime,
  })
  if (!resolved.model) {
    const e = new Error(`model resolution failed: ${resolved.error || `unknown model ${piModel}`}`)
    e.status = 400
    throw e
  }
  if (resolved.warning) h.log(`pi model resolution: ${resolved.warning}`)

  // The gate extension is registered unconditionally and consults `mode` at
  // call time, so a mid-session mode switch applies to the next tool call —
  // matching the claude driver's setPermissionMode semantics.
  const gateExtension = {
    name: 'zwrm-gate',
    factory: (pi) => {
      pi.on('tool_call', async (ev) => {
        // After /end, the in-flight turn may still reach for another tool; a
        // new pending prompt would wedge the wind-down forever, so deny
        // immediately (no permission.request — nobody is left to answer it).
        if (s.ending) return { block: true, reason: 'session ended' }
        // Tool policy (#1330) rules ahead of the permission mode: a blocked
        // tool is refused in EVERY mode, and a confirm verdict (destructive
        // zwrm subcommand) forces the permission prompt below even in
        // bypassPermissions / auto-approve. Unattended runs have nobody to
        // answer a prompt, so the evaluator downgrades confirm to a block
        // there instead of wedging the turn.
        let forceConfirm = false
        if (spec.tool_policy) {
          const verdict = evaluateToolPolicy(spec.tool_policy, ev.toolName, ev.input,
            { interactive: Boolean(spec.interactive) })
          if (verdict.block) return { block: true, reason: verdict.reason }
          forceConfirm = Boolean(verdict.confirm)
        }
        if (mode === 'bypassPermissions' && !forceConfirm) return undefined
        if (spec.auto_approve && !forceConfirm && !h.isEscalatedTool(ev.toolName, spec.escalate_servers)) {
          return undefined
        }
        const requestId = randomUUID()
        s.pusher.emit('permission.request', {
          request_id: requestId,
          tool_name: ev.toolName,
          input: ev.input,
          tool_use_id: ev.toolCallId,
        })
        h.setState(s, 'blocked')
        // Resolved by POST /permissions/{request_id} through the shared
        // pending map — or canceled by interrupt()/end/shutdown, which MUST
        // resolve it (the SDK never aborts a pending extension handler, so an
        // unresolved promise here deadlocks session.abort()).
        const decision = await new Promise((resolve) => {
          s.pending.set(requestId, { resolve, toolName: ev.toolName, input: ev.input, ts: Date.now() })
        })
        if (decision.behavior === 'allow') {
          // pi's documented argument-patch mechanism: mutate input in place.
          // Snapshot FIRST: handlePermission's default updatedInput is
          // p.input, which aliases ev.input — deleting before copying would
          // wipe the approved tool's arguments (review finding).
          if (decision.updatedInput && typeof decision.updatedInput === 'object') {
            const next = { ...decision.updatedInput }
            for (const k of Object.keys(ev.input)) delete ev.input[k]
            Object.assign(ev.input, next)
          }
          return undefined
        }
        return { block: true, reason: decision.message || 'denied by user' }
      })
    },
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    // Belt for the platform-managed skill library (#1064): settings.json's
    // skills entry (seeded by init, #1062) normally points here, but the
    // file is user-editable — managed skills must survive its loss.
    additionalSkillPaths: [pathResolve(home, '.claude/skills')],
    ...(spec.append_system_prompt ? { appendSystemPrompt: [spec.append_system_prompt] } : {}),
    extensionFactories: [gateExtension],
  })
  await resourceLoader.reload()

  // The MCP → pi tools bridge (#1065): connectors + the reserved zwrm
  // session server surface as `mcp__<slug>__<tool>` custom tools, so the
  // gate's escalation matching works unchanged. Unattended runs also get the
  // native sleep/park tools (the claude driver's `platform` server analog).
  // Built LAST among the fallible construction steps so an earlier throw
  // (resume jail, model resolution, loader) can't leak connected clients.
  const bridge = await buildBridgedTools(spec.mcp_servers, h.log)
  const customTools = [...bridge.tools, ...(spec.interactive ? [] : buildRunTools(s, h))]

  let session
  try {
    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: resolved.model,
      ...(mapEffort(spec.effort) ? { thinkingLevel: mapEffort(spec.effort) } : {}),
      sessionManager,
      resourceLoader,
      ...(customTools.length > 0 ? { customTools } : {}),
    })
    session = created.session
    if (created.modelFallbackMessage) h.log(`pi session ${s.id}: ${created.modelFallbackMessage}`)
  } catch (err) {
    bridge.close()
    const e = new Error(`failed to start pi session: ${err?.message || err}`)
    e.status = 502
    throw e
  }

  const stats0 = session.getSessionStats()
  // Session-row cost starts at zero even when the pi session file carries
  // history (resume) — see the cost note in the header.
  const costBaseline = stats0.cost || 0
  s.sdkSessionId = stats0.sessionFile || ''

  // ---- lifecycle ------------------------------------------------------------
  let closed = false
  let finished = false
  // abortGen invalidates in-flight work: an agent cycle started before an
  // interrupt must not emit a result (claude parity: an interrupted turn
  // produces no sdk.result), and a prompt rejection from the abort must not
  // fail the session.
  let abortGen = 0
  let turnEnds = 0
  // Per-cycle bookkeeping, stamped at agent_start.
  let cycleGen = 0
  let cycleStartMS = 0
  let cycleStartTurns = 0
  // serial orders the async reactions (result emits, finish) behind the
  // synchronous subscribe callback, preserving event order on the wire.
  let serial = Promise.resolve()
  const chain = (fn) => {
    serial = serial.then(fn).catch((err) => h.log(`pi session ${s.id} reaction failed: ${err?.stack || err}`))
    return serial
  }

  async function emitResult(messages, startTurns, startMS) {
    if (finished) return
    const stats = session.getSessionStats()
    const cost = Math.max(0, (stats.cost || 0) - costBaseline)
    const usage = sumAssistantUsage(messages) || stats.tokens
    // A cycle whose final assistant message ended stopReason:'error' is a
    // FAILED turn (#1363): the model call itself died (expired gateway
    // credential, upstream 4xx/5xx) and pi settles without throwing, so the
    // fail() path never sees it. Recording it as subtype=success with an
    // empty result is the #1149 silent-failure shape — the CP shows a green
    // "Turn completed" over a chat that returned nothing. The claude error
    // subtype keeps the CP contract: preview is not overwritten, the
    // dashboard renders an error result carrying the reason.
    const turnError = turnErrorMessage(messages)
    s.lastResult = {
      subtype: turnError ? 'error_during_execution' : 'success',
      duration_ms: Date.now() - startMS,
      num_turns: Math.max(1, turnEnds - startTurns),
      total_cost_usd: cost,
      usage: usagePayload(usage),
    }
    // Durability before observability: the CP tears the VM down on
    // sdk.result for session-plane runs (#888); the pi session file must
    // survive that.
    await h.syncToDisk()
    s.pusher.emit('sdk.result', resultPayload({
      subtype: s.lastResult.subtype,
      resultText: turnError || lastAssistantText(messages),
      costUSD: cost,
      usage,
      numTurns: s.lastResult.num_turns,
      durationMS: s.lastResult.duration_ms,
    }))
  }

  async function finish() {
    if (finished) return
    finished = true
    unsubscribe()
    bridge.close()
    try { session.dispose() } catch {}
    await h.syncToDisk()
    s.state = 'ended'
    s.pusher.emit('session.ended', { sdk_session_id: s.sdkSessionId, last_result: s.lastResult })
  }

  async function fail(err) {
    if (finished) return
    finished = true
    unsubscribe()
    bridge.close()
    try { session.dispose() } catch {}
    h.log(`pi session ${s.id} failed: ${err?.stack || err}`)
    const c = classifyPiError(err, piProvider)
    await h.syncToDisk()
    s.state = 'error'
    s.pusher.emit('session.error', { message: c.message, cause: c.cause, detail: c.detail })
  }

  const unsubscribe = session.subscribe((ev) => {
    try {
      switch (ev.type) {
        case 'agent_start':
          cycleGen = abortGen
          cycleStartMS = Date.now()
          cycleStartTurns = turnEnds
          break
        case 'message_update': {
          const p = partialPayload(ev.assistantMessageEvent)
          if (p) s.pusher.emit('sdk.partial', p, { ephemeral: true })
          break
        }
        case 'message_end':
          if (ev.message?.role === 'assistant') {
            const payload = assistantPayload(ev.message)
            // An errored call that produced no content at all has nothing
            // the timeline can render — it used to surface as a raw-JSON
            // fallback card (#1363). Drop it: the failure reaches the user
            // through the error result emitResult builds from the same
            // message. Partial content (text streamed before the failure)
            // still ships, carrying error_message.
            if (payload.message.content.length > 0 || ev.message.stopReason !== 'error') {
              s.pusher.emit('sdk.assistant', payload)
            }
          }
          break
        case 'turn_end':
          turnEnds++
          if (Array.isArray(ev.toolResults) && ev.toolResults.length > 0) {
            s.pusher.emit('sdk.user', toolResultsPayload(ev.toolResults))
          }
          break
        case 'agent_end': {
          if (ev.willRetry) break // the SDK retries this cycle; not a result
          if (cycleGen !== abortGen) break // interrupted cycle: no result (claude parity)
          const messages = ev.messages || []
          const startTurns = cycleStartTurns
          const startMS = cycleStartMS || Date.now()
          chain(() => emitResult(messages, startTurns, startMS))
          break
        }
        case 'agent_settled':
          // The SDK's own "nothing left to do": no active run, retry, or
          // queued continuation. Chained behind any pending result emit.
          chain(async () => {
            if (finished) return
            if (closed || s.ending) return finish()
            h.setState(s, 'idle')
          })
          break
        default:
          // pi-internal events (queue_update, entry_appended, compaction)
          // drive nothing here; forwarding untranslated shapes would put
          // unreadable payloads in the durable timeline.
      }
    } catch (err) {
      h.log(`pi event translation failed (${ev?.type}): ${err?.stack || err}`)
    }
  })

  // doPrompt delivers a message. streamingBehavior comes from the SDK's OWN
  // streaming state at call time (the driver has no reliable proxy), and the
  // preflight race — prompt A accepted but not yet "streaming" when B
  // arrives — surfaces as an "already processing" throw that is retried as a
  // followUp (bounded), not treated as a session failure.
  function doPrompt(text, retriesLeft = 2) {
    const myGen = abortGen
    const opts = session.isStreaming ? { streamingBehavior: 'followUp' } : undefined
    session.prompt(text, opts).catch((err) => {
      if (abortGen !== myGen || finished) return
      const msg = String(err?.message || err)
      if (retriesLeft > 0 && /already processing|streamingBehavior/i.test(msg)) {
        session.prompt(text, { streamingBehavior: 'followUp' }).catch((err2) => {
          if (abortGen !== myGen || finished) return
          const msg2 = String(err2?.message || err2)
          if (retriesLeft > 1 && /already processing|streamingBehavior/i.test(msg2)) {
            doPrompt(text, 0)
            return
          }
          chain(() => fail(err2))
        })
        return
      }
      chain(() => fail(err))
    })
  }

  return {
    harness: 'pi',

    start() {
      // Mirrors claude's init ordering: session.started is emitted by the
      // caller first, then the init event that carries the resume handle.
      s.pusher.emit('sdk.system', initPayload(s.sdkSessionId, resolved.model.id))
    },

    queueMessage(text) {
      if (closed || finished) return false
      h.setState(s, 'working')
      doPrompt(text)
      return true
    },

    async interrupt() {
      abortGen++
      // The SDK awaits extension handlers unconditionally — a pending gate
      // promise would deadlock abort()'s wait-for-idle. Cancel them first
      // (emits the same permission.decision cancel events as claude's
      // abort-signal listeners).
      h.cancelPendingPermissions(s, 'interrupted')
      try {
        await session.abort()
      } catch (err) {
        h.log(`pi interrupt failed: ${err?.message || err}`)
      }
      await h.syncToDisk()
      if (!finished && session.isIdle) h.setState(s, 'idle')
    },

    async setPermissionMode(newMode) {
      if (!SUPPORTED_PERMISSION_MODES.has(newMode)) {
        const e = new Error(`the pi harness supports permission modes 'default' and 'bypassPermissions', not '${newMode}'`)
        e.status = 400
        throw e
      }
      mode = newMode
    },

    beginEnd() {
      closed = true
      if (session.isIdle) chain(finish)
      // else agent_settled finishes the wind-down.
    },

    async shutdownStop() {
      closed = true
      abortGen++
      // Server shutdown cancels pending permissions before calling us; the
      // abort below then has nothing to deadlock on.
      try {
        await session.abort()
      } catch {
        // best-effort
      }
      chain(finish)
      await serial
    },
  }
}
