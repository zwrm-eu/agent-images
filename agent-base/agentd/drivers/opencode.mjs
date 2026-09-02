// OpenCode harness driver (#1391): hosts a session by spawning `opencode
// serve` and driving its v1 HTTP surface + /event SSE stream, translating
// into the platform's claude-stream-json-shaped contract (see
// drivers/opencode-translate.mjs for the load-bearing consumers).
//
// Differences from the claude, pi, and codex drivers, by design:
//  - Out-of-process over HTTP, one child per session (the codex shape with a
//    different wire). The child is password-locked to this daemon: an open
//    server would let the model answer its own permission asks via bash.
//  - The resume handle is the OpenCode SESSION ID — an opaque string; the
//    session store (~/.local/share/opencode/opencode.db) lives on the
//    workspace volume, so resume survives VM destroy. An unresolvable handle
//    starts fresh and re-stamps (the codex self-heal rule).
//  - Turn model: POST /session/:id/prompt_async opens work; `session.idle`
//    (for OUR session only — task-tool subagents stream under their own ids)
//    closes the turn. Exactly one sdk.result per turn, including failed ones.
//  - Permission gate: the server publishes `permission.asked` (probed name —
//    the docs' permission.updated is stale) and pauses the tool; the reply is
//    POST /session/:id/permissions/:id {response: once|reject}. The ask's own
//    id doubles as the platform request_id. A rejection ends the turn
//    server-side with a canned tool error; the v1 reply route IGNORES a
//    message body, so — unlike the other harnesses — denial text does not
//    reach the model. Gate keys come from OPENCODE_PERMISSION below.
//  - Cost is REAL but display-only: the seeded catalog carries gateway
//    prices, OpenCode reports session-cumulative cost, and the driver
//    subtracts the baseline captured at resume (the pi open-baseline rule).
//    Billing happens at the gateway (#1193); the CP does not re-bank this.
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeServer, OpenCodeHTTPError } from './opencode-client.mjs'
import {
  OPENCODE_PROVIDER_ID,
  buildSessionConfig,
  canonicalOpenCodeToolName,
  classifyOpenCodeError,
  gateInputFor,
  initPayload,
  partialPayload,
  reasoningPayload,
  resultPayload,
  textPayload,
  toolResultPayload,
  toolUsePayload,
} from './opencode-translate.mjs'
import { normalizeTodos } from './todos.mjs'
import { commandPrompt, normalizeCommandList, resolveCommand } from '../session-control.mjs'

// Bounded teardown (the codex rule): a wedged server must not hang
// /interrupt or SIGTERM shutdown; turn-carrying calls stay unbounded.
const TEARDOWN_TIMEOUT_MS = 10_000

// The permission modes this harness can host, exported for the registry
// (#1160 rule: the table cannot disagree with construction).
export const SUPPORTED_PERMISSION_MODES = new Set(['default', 'bypassPermissions'])

// The ROOT-OWNED config root the image bakes (#1392): the boot config's
// apply step writes the platform config file here, and run/ carries the
// baked sleep/sleep_until file tools. OPENCODE_CONFIG_DIR points at one of
// these so the model user's ~/.config/opencode never enters the trust path;
// interactive sessions use the tools-free root.
const PLATFORM_CONFIG_PATH = '/etc/opencode/opencode.json'
// session/ is the EMPTY subtree: driver sessions must read neither the
// terminal AGENTS.md (instructions arrive via the session config; both would
// double the prompt) nor the run tools.
const CONFIG_DIR_INTERACTIVE = '/etc/opencode/session'
const CONFIG_DIR_RUN = '/etc/opencode/run'

export async function createOpenCodeDriver(s, spec, h) {
  const home = process.env.HOME || '/home/agent'
  const cwd = spec.cwd || home

  let mode = spec.permission_mode || 'bypassPermissions'
  if (!SUPPORTED_PERMISSION_MODES.has(mode)) {
    const e = new Error(`the opencode harness supports permission modes 'default' and 'bypassPermissions', not '${mode}'`)
    e.status = 400
    throw e
  }

  // Connectors and the reserved zwrm platform server ride OpenCode's NATIVE
  // MCP client (#1392): probed on the pinned binary, a permission-table entry
  // naming the tool makes its calls raise permission.asked, so the platform
  // gate and escalation hold without a bridge process. The slug set also
  // drives wire→canonical tool-name mapping below.
  const mcpSlugs = Object.keys(spec.mcp_servers || {})

  // Per-session env for the child: the gateway credential above all
  // (ZWRM_GATEWAY_TOKEN, which the seeded provider config interpolates), and
  // the egress-relevant disable flags set EXPLICITLY — the daemon's own env
  // does not source /etc/profile.d, so relying on the image's profile entries
  // here would stall gateway-only VMs on update/model/LSP fetches (the pi
  // PI_SKIP_VERSION_CHECK lesson).
  const childEnv = { ...process.env }
  for (const [k, v] of Object.entries(spec.env || {})) {
    if (k === 'HOME') continue // moving HOME would move the session db out from under the resume handles
    childEnv[k] = v
  }
  childEnv.OPENCODE_DISABLE_AUTOUPDATE = '1'
  childEnv.OPENCODE_DISABLE_MODELS_FETCH = '1'
  childEnv.OPENCODE_DISABLE_LSP_DOWNLOAD = '1'
  // The workspace tree is the MODEL'S writable territory: a repo-planted
  // opencode.json / .opencode/{tool,plugin} must never configure the harness
  // (probed: without this flag the server reads the project's opencode.json).
  childEnv.OPENCODE_DISABLE_PROJECT_CONFIG = '1'
  childEnv.OPENCODE_CONFIG_DIR = spec.interactive ? CONFIG_DIR_INTERACTIVE : CONFIG_DIR_RUN

  // The platform half of the config, rendered by the control plane
  // (build.OpenCodeConfigJSON) and written by the boot-config apply step.
  // Missing is survivable for construction — tests and pre-#1392 images —
  // but a real session then has no provider and fails at the first prompt
  // with a clear model error, so log loudly here.
  let platformCfg = null
  const platformCfgPath = process.env.ZWRM_OPENCODE_PLATFORM_CONFIG || PLATFORM_CONFIG_PATH
  try {
    platformCfg = JSON.parse(readFileSync(platformCfgPath, 'utf8'))
  } catch (err) {
    h.log(`opencode: no platform config at ${platformCfgPath} (${err?.message || err}); the session has no gateway provider`)
  }

  // append_system_prompt (platform instructions + memory block + run
  // preamble) rides OpenCode's `instructions`, which APPEND to the system
  // prompt — the codex developerInstructions rule: add, never replace. A
  // file path is the only carrier, so it lands in a 0600 daemon temp file.
  let instrDir = null
  let instructionsPath = null
  if (spec.append_system_prompt) {
    instrDir = await mkdtemp(join(tmpdir(), 'zwrm-opencode-'))
    instructionsPath = join(instrDir, 'platform-instructions.md')
    await writeFile(instructionsPath, spec.append_system_prompt, { mode: 0o600 })
  }
  const cleanupInstr = async () => {
    if (!instrDir) return
    await rm(instrDir, { recursive: true, force: true }).catch(() => {})
    instrDir = null
  }

  childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildSessionConfig({
    platform: platformCfg,
    mcpServers: spec.mcp_servers,
    interactive: !!spec.interactive,
    instructionsPath,
  }))

  // Run tools (#1392): the baked file tools long-poll the daemon's
  // /v1/platform-tools endpoint; the per-session bearer keeps other VM
  // processes from parking or waking the turn. ZWRM_AGENTD_PORT is exported
  // by server.mjs at listen time.
  if (!spec.interactive) {
    s.platformToolsToken = randomBytes(16).toString('hex')
    childEnv.ZWRM_PLATFORM_TOOLS_URL =
      `http://127.0.0.1:${process.env.ZWRM_AGENTD_PORT || '9924'}/v1/platform-tools`
    childEnv.ZWRM_PLATFORM_TOOLS_TOKEN = s.platformToolsToken
  }

  let closed = false
  let finished = false
  // abortGen invalidates in-flight work: a turn started before an interrupt
  // must not emit a result (claude parity).
  let abortGen = 0
  // serial orders async reactions behind the synchronous event callback,
  // preserving event order on the wire (the codex chain).
  let serial = Promise.resolve()
  const chain = (fn) => {
    serial = serial.then(fn).catch((err) => h.log(`opencode session ${s.id} reaction failed: ${err?.stack || err}`))
    return serial
  }

  // ---- turn bookkeeping -----------------------------------------------------
  let turnActive = false
  let turnGen = 0
  // turnSeq numbers platform turns monotonically. The result guard is
  // per-SEQUENCE, not a boolean: a boolean reset by the next sendPrompt let a
  // message racing the chained result emit corrupt BOTH turns (review) — the
  // old result lost its text and the new turn's result was suppressed.
  let turnSeq = 0
  let resultEmittedSeq = 0
  let turnStartMS = 0
  let turnError = null
  let lastText = '' // the newest finished assistant text part — the run summary
  let lastTokens = null // the last assistant message's token breakdown
  let costNow = 0 // OpenCode's session-cumulative cost, tracked from message.updated
  let baselineCost = 0 // cumulative cost at resume; see resultPayload's contract
  // The abort generation of the last prompt WE sent; the busy re-arm below
  // must not resurrect a turn the user just interrupted.
  let lastPromptGen = -1
  // message id -> role, from message.updated (probed: it precedes the
  // message's parts). The event bus streams USER message parts too — without
  // this filter the user's own prompt renders as assistant text and can
  // become the run summary (review).
  const msgRoles = new Map()
  // Tool parts mutate in place; remember what was already emitted so a
  // re-delivered update cannot double-render (SSE reconnect replays nothing,
  // but updates for one part legitimately arrive many times).
  let toolEmitted = new Map() // callID -> 'use' | 'result'
  // Text parts stream by growing in place: keep the emitted length per part
  // for delta extraction, and the flushed length for the boundary flush.
  let textParts = new Map() // partID -> {text, emittedLen, flushedLen}
  // OpenCode ask id -> platform pending entry exists (the ask id IS the
  // platform request_id); tracked to reply-reject on interrupt/shutdown.
  const openAsks = new Set()
  // The normalized command list (#1429), fetched once — see listCommands.
  let latestCommands = null

  // resetTurnState opens a fresh platform turn's bookkeeping. Maps are
  // REPLACED, not cleared: a chained closure from the previous turn may still
  // hold the old ones (snapshot semantics), and per-turn replacement also
  // keeps them from growing for the workspace's lifetime (review).
  function resetTurnState() {
    turnSeq++
    turnGen = abortGen
    turnStartMS = Date.now()
    turnError = null
    lastText = ''
    lastTokens = null
    toolEmitted = new Map()
    textParts = new Map()
    msgRoles.clear()
  }

  const currentModel = () => spec.model || ''

  // flushText emits accumulated text parts as full assistant messages, in
  // part order of arrival. Called at the boundaries a text block is known
  // complete: a tool part appears, or the turn ends. A part that grew AFTER
  // an earlier flush emits its unflushed tail as a further message — the
  // ephemeral partials are not a durable record (review).
  function flushText() {
    for (const [, t] of textParts) {
      const tail = t.text.slice(t.flushedLen)
      if (!tail) continue
      t.flushedLen = t.text.length
      s.pusher.emit('sdk.assistant', textPayload(tail, currentModel()))
    }
  }

  // emitResult reports one turn from a SNAPSHOT taken synchronously when its
  // idle arrived: the chain's awaits (cost read, sync) may interleave with
  // the NEXT turn's prompt, and reading live state here reported the new
  // turn's blank text under the old turn's result (review).
  // The server reserves command exclusivity (s.controlBusy, #1429) before
  // driver.invokeCommand and the DRIVER releases it at the turn's terminal
  // boundary — result, failure, or interrupt — mirroring claude's
  // finishCommandTurn. No model restore is needed here: opencode's model
  // override is per-call, never session state.
  function releaseControl() {
    if (s.controlBusy) s.controlBusy = null
  }

  async function emitResult(subtype, snap) {
    if (finished || resultEmittedSeq >= snap.seq) return
    resultEmittedSeq = snap.seq
    const durationMS = snap.startMS ? Date.now() - snap.startMS : 0
    // The session row is the durable cumulative source; the tracked value is
    // the fallback when the server is already unreachable (child died — the
    // fail path emits no result anyway, but a racing idle should not throw).
    let cost = snap.cost
    try {
      const sess = await server.request('GET', `/session/${ocSessionId}`, undefined, { timeoutMS: TEARDOWN_TIMEOUT_MS })
      if (typeof sess?.cost === 'number') cost = sess.cost
    } catch (err) {
      h.log(`opencode: could not read session cost: ${err?.message || err}`)
    }
    const costUSD = Math.max(0, cost - baselineCost)
    s.lastResult = {
      subtype,
      duration_ms: durationMS,
      num_turns: 1,
      total_cost_usd: costUSD,
      usage: snap.tokens ? {
        input_tokens: snap.tokens.input ?? 0,
        output_tokens: snap.tokens.output ?? 0,
        cache_read_input_tokens: snap.tokens.cache?.read ?? 0,
        cache_creation_input_tokens: snap.tokens.cache?.write ?? 0,
      } : undefined,
    }
    // Durability before observability: the CP tears the VM down on sdk.result
    // for session-plane runs (#888); the session db must survive that.
    await h.syncToDisk()
    s.pusher.emit('sdk.result', resultPayload({
      subtype,
      resultText: subtype === 'success' ? snap.text : String(snap.error?.message || snap.error?.name || 'turn failed'),
      costUSD,
      tokens: snap.tokens,
      numTurns: 1,
      durationMS,
    }))
    releaseControl()
    if (finished) return
    if (closed || s.ending) {
      await finish()
      return
    }
    if (!turnActive) h.setState(s, 'idle')
  }

  async function finish() {
    if (finished) return
    finished = true
    server.close()
    await cleanupInstr()
    await h.syncToDisk()
    s.state = 'ended'
    s.pusher.emit('session.ended', { sdk_session_id: s.sdkSessionId, last_result: s.lastResult })
  }

  async function fail(err) {
    if (finished) return
    finished = true
    releaseControl()
    server.close()
    await cleanupInstr()
    h.log(`opencode session ${s.id} failed: ${err?.stack || err}`)
    const c = classifyOpenCodeError(err)
    await h.syncToDisk()
    s.state = 'error'
    s.pusher.emit('session.error', { message: c.message, cause: c.cause, detail: c.detail })
  }

  // ---- permission gate ------------------------------------------------------
  // One ask at a time is OpenCode's own behavior (the tool pauses); the
  // pending map still supports several, matching the other drivers.
  async function onAsk(ask) {
    const askId = ask?.id
    if (!askId) return
    const reply = async (response) => {
      try {
        await server.request('POST', `/session/${ocSessionId}/permissions/${encodeURIComponent(askId)}`,
          { response }, { timeoutMS: TEARDOWN_TIMEOUT_MS })
      } catch (err) {
        // A reply that no longer lands (turn aborted, server gone) is not a
        // session failure; the turn's own terminal path reports the truth.
        h.log(`opencode: permission reply failed: ${err?.message || err}`)
      }
    }
    // After /end nothing may block on a human (server semantics: pending
    // asks were already denied); auto-deny new ones.
    if (s.ending) return reply('reject')
    if (mode === 'bypassPermissions') return reply('once')
    // The gate and the escalation policy match the CANONICAL name: an MCP
    // ask arrives under OpenCode's wire name (`<slug>_<tool>`), and
    // mcp__<slug>__<tool> is what every harness's policy speaks (#731).
    const canonical = canonicalOpenCodeToolName(ask.permission ?? '', mcpSlugs)
    // Run policy: auto-approve everything except escalated connector tools.
    if (spec.auto_approve && !h.isEscalatedTool(canonical, spec.escalate_servers)) {
      return reply('once')
    }
    s.pusher.emit('permission.request', {
      request_id: askId,
      tool_name: canonical,
      input: gateInputFor(ask),
      tool_use_id: ask.tool?.callID ?? '',
    })
    h.setState(s, 'blocked')
    openAsks.add(askId)
    let decision
    try {
      decision = await new Promise((resolve) => {
        s.pending.set(askId, { resolve, toolName: ask.permission ?? '', input: gateInputFor(ask), ts: Date.now() })
      })
    } finally {
      openAsks.delete(askId)
    }
    // 'once', never 'always': an always-grant would persist in OpenCode's
    // store past this session and bypass the platform gate next time.
    // updatedInput cannot be applied — the reply body carries no input — so a
    // reviewer's edit is deliberately not honoured here (unlike claude/pi).
    await reply(decision.behavior === 'allow' ? 'once' : 'reject')
  }

  // ---- event translation ----------------------------------------------------
  function onEvent(ev) {
    const type = ev?.type
    const props = ev?.properties ?? {}
    // Everything the driver reads is session-scoped; foreign sessions (task
    // subagents, other projects) stay out of the transcript.
    const evSession = props.sessionID ?? props.part?.sessionID ?? props.info?.sessionID
    if (evSession && evSession !== ocSessionId) return
    try {
      switch (type) {
        case 'permission.asked':
          void onAsk(props)
          break

        case 'message.part.delta': {
          // Streaming granularity when the server offers it; the
          // part.updated diffing below covers builds that do not. A delta for
          // a part we have not seen yet still creates the entry (review) —
          // dropping it lost the prefix until a full-text update arrived.
          const partID = props.partID ?? props.part?.id
          const delta = props.delta ?? ''
          if (!partID || typeof delta !== 'string' || !delta) break
          let t = textParts.get(partID)
          if (!t) {
            t = { text: '', emittedLen: 0, flushedLen: 0 }
            textParts.set(partID, t)
          }
          t.text += delta
          t.emittedLen = t.text.length
          const p = partialPayload(delta)
          if (p) s.pusher.emit('sdk.partial', p, { ephemeral: true })
          break
        }

        case 'message.part.updated': {
          const part = props.part
          if (!part) break
          // The bus streams USER message parts too (probed): without this,
          // the user's own prompt renders as assistant text and can become
          // the run summary. message.updated precedes a message's parts
          // (probed), so the role is known by the time parts arrive; an
          // unknown id defaults to assistant — dropping real output is the
          // worse failure.
          if ((part.type === 'text' || part.type === 'reasoning') &&
              msgRoles.get(part.messageID) === 'user') break
          if (part.type === 'text') {
            let t = textParts.get(part.id)
            if (!t) {
              t = { text: '', emittedLen: 0, flushedLen: 0 }
              textParts.set(part.id, t)
            }
            const full = part.text ?? ''
            if (full.length > t.emittedLen) {
              const p = partialPayload(full.slice(t.emittedLen))
              if (p) s.pusher.emit('sdk.partial', p, { ephemeral: true })
              t.emittedLen = full.length
            }
            if (full) {
              t.text = full
              lastText = full
            }
          } else if (part.type === 'reasoning') {
            // Emitted once, when finished (time.end); deltas are noise the
            // transcript never renders for other harnesses either.
            if (part.time?.end && !toolEmitted.has(`reasoning:${part.id}`)) {
              toolEmitted.set(`reasoning:${part.id}`, 'result')
              if (part.text) s.pusher.emit('sdk.assistant', reasoningPayload(part.text, currentModel()))
            }
          } else if (part.type === 'tool') {
            const callID = part.callID ?? part.id
            const status = part.state?.status
            const stage = toolEmitted.get(callID)
            // The transcript speaks canonical names too — one tool call must
            // not appear under two names across harnesses (the codex rule).
            const named = { ...part, tool: canonicalOpenCodeToolName(part.tool, mcpSlugs) }
            // Text preceding a tool call is complete once the call appears.
            if (!stage) flushText()
            if ((status === 'running' || status === 'pending') && !stage) {
              toolEmitted.set(callID, 'use')
              s.pusher.emit('sdk.assistant', toolUsePayload(named, currentModel()))
            } else if ((status === 'completed' || status === 'error') && stage !== 'result') {
              if (!stage) {
                // Terminal state for a call whose start we never saw (SSE
                // drop): emit the pair so the result is not orphaned.
                s.pusher.emit('sdk.assistant', toolUsePayload(named, currentModel()))
              }
              toolEmitted.set(callID, 'result')
              s.pusher.emit('sdk.user', toolResultPayload(named))
              // OpenCode executes todowrite itself, so a completed call IS
              // the adopted list — it feeds the platform task list (#1424)
              // as a wholesale todo.updated snapshot, like claude's
              // TodoWrite after its tool_result. Errors (including
              // permission rejects) never adopted anything. Raw wire name:
              // an MCP tool can only reach here slug-prefixed.
              if (status === 'completed' && part.tool === 'todowrite') {
                const todos = normalizeTodos(part.state?.input?.todos)
                if (todos) s.pusher.emit('todo.updated', { todos })
                else h.log('opencode: todowrite input with unrecognized shape dropped')
              }
            }
          }
          break
        }

        case 'message.updated': {
          const info = props.info
          if (info?.id && info.role) msgRoles.set(info.id, info.role)
          if (info?.role !== 'assistant') break
          if (info.tokens && (info.tokens.input || info.tokens.output)) lastTokens = info.tokens
          if (typeof info.cost === 'number' && info.cost > costNow) costNow = info.cost
          if (info.error) {
            if (turnActive) {
              turnError = info.error
            } else {
              // The turn already reported; rewriting state now would hang
              // the error on the NEXT turn (review). Log — the model-facing
              // failure surfaced through the turn's own terminal path.
              h.log(`opencode: message error after turn end: ${JSON.stringify(info.error).slice(0, 300)}`)
            }
          }
          break
        }

        case 'session.error': {
          if (props.error) turnError = props.error
          // Terminal only when no turn is open to carry it: an in-turn error
          // is reported by that turn's result when idle lands.
          if (!turnActive) h.log(`opencode session error outside a turn: ${JSON.stringify(props.error ?? {}).slice(0, 300)}`)
          break
        }

        case 'session.status': {
          const st = props.status?.type
          if (st === 'retry') h.log(`opencode retrying: ${props.status?.message ?? ''}`)
          // The fold-vs-new ambiguity (review): a follow-up posted just as
          // the live turn idled is started by the server as a NEW turn the
          // driver never armed — its output would stream into a session the
          // platform believes idle, and its idle would be dropped. `busy`
          // with no armed turn re-opens one, UNLESS an interrupt superseded
          // the last prompt (lastPromptGen) — a cancelled turn's tail must
          // not resurrect itself.
          if (st === 'busy' && !turnActive && !finished && !closed && !s.ending &&
              lastPromptGen === abortGen && resultEmittedSeq >= turnSeq) {
            resetTurnState()
            turnActive = true
            h.setState(s, 'working')
          }
          break
        }

        case 'session.idle': {
          if (!turnActive) break
          // Flush and snapshot SYNCHRONOUSLY: the chain below awaits, and a
          // new prompt landing in that window replaces the per-turn state
          // (review — reading it late corrupted both turns' results).
          flushText()
          const snap = {
            seq: turnSeq,
            gen: turnGen,
            text: lastText,
            tokens: lastTokens,
            error: turnError,
            startMS: turnStartMS,
            cost: costNow,
          }
          turnActive = false
          chain(async () => {
            // An interrupted turn produces no result (claude parity).
            if (snap.gen !== abortGen) return
            const failed = Boolean(snap.error) && !/abort/i.test(String(snap.error?.name ?? ''))
            await emitResult(failed ? 'error_during_execution' : 'success', snap)
          })
          break
        }

        default:
          // plugin.added, catalog.updated, session.diff, heartbeats, …
          // drive nothing here.
      }
    } catch (err) {
      h.log(`opencode event translation failed (${type}): ${err?.stack || err}`)
    }
  }

  // The child dying is terminal either way; a wind-down in progress ends
  // cleanly rather than reporting the failure it was about to cause.
  function onExit(err) {
    if (finished) return
    chain(() => (closed ? finish() : fail(err)))
  }

  // ---- construction ---------------------------------------------------------
  const server = new OpenCodeServer({
    // The image pins `opencode` on PATH; the override exists for the fake
    // server in tests and for pointing at a specific build.
    bin: process.env.ZWRM_OPENCODE_BIN || 'opencode',
    cwd,
    env: childEnv,
    log: h.log,
    onEvent,
    onExit,
  })
  try {
    await server.start()
  } catch (err) {
    server.close()
    await cleanupInstr()
    const e = new Error(`failed to start opencode serve: ${err?.message || err}`)
    e.status = 502
    throw e
  }

  // Resume, with the codex self-heal: a handle that no longer resolves must
  // not wedge the workspace key forever — start fresh and let the init event
  // re-stamp it.
  let ocSessionId = ''
  const resumeHandle = spec.resume_sdk_session_id || ''
  if (resumeHandle) {
    try {
      const sess = await server.request('GET', `/session/${encodeURIComponent(resumeHandle)}`)
      ocSessionId = sess?.id || ''
      if (typeof sess?.cost === 'number') baselineCost = sess.cost
    } catch (err) {
      h.log(`opencode: resume handle ${resumeHandle} did not resolve (${err?.message || err}); starting a fresh session`)
    }
  }
  if (!ocSessionId) {
    try {
      const sess = await server.request('POST', '/session', {})
      ocSessionId = sess?.id || ''
    } catch (err) {
      server.close()
      await cleanupInstr()
      const e = new Error(`failed to create opencode session: ${err?.message || err}`)
      e.status = 502
      throw e
    }
    if (!ocSessionId) {
      server.close()
      await cleanupInstr()
      const e = new Error('opencode returned a session without an id')
      e.status = 502
      throw e
    }
  }
  s.sdkSessionId = ocSessionId
  server.startEvents()
  // Gate construction on the /event stream being live: opencode does not
  // replay, so a prompt sent before the subscription attaches loses the whole
  // turn's message events (the completion can outrun a fire-and-forget
  // subscribe on a cold VM — observed as an idle with empty result and no
  // assistant text). A stream that never connects fails the session loudly
  // here rather than silently dropping turns. Bounded so a wedged /event
  // cannot hang session creation forever.
  try {
    await Promise.race([
      server.subscribed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('opencode /event did not connect within 15s')), 15000).unref()),
    ])
  } catch (err) {
    server.close()
    await cleanupInstr()
    const e = new Error(`opencode event stream unavailable: ${err?.message || err}`)
    e.status = 502
    throw e
  }

  // ---- turn dispatch --------------------------------------------------------
  function sendPrompt(text) {
    const myGen = abortGen
    lastPromptGen = myGen
    resetTurnState()
    turnActive = true
    const body = {
      parts: [{ type: 'text', text }],
      // The seeded gateway provider (#1392); the model id is the gateway
      // slug the control plane resolved (state.HarnessModelSlug).
      ...(spec.model ? { model: { providerID: OPENCODE_PROVIDER_ID, modelID: spec.model } } : {}),
    }
    server.request('POST', `/session/${ocSessionId}/prompt_async`, body)
      .catch((err) => {
        if (abortGen !== myGen || finished) return
        turnActive = false
        chain(() => fail(err))
      })
  }

  return {
    harness: 'opencode',

    start() {
      // Mirrors claude's init ordering: session.started first (the caller),
      // then the init event carrying the resume handle.
      s.pusher.emit('sdk.system', initPayload(ocSessionId, currentModel()))
    },

    queueMessage(text) {
      if (closed || finished) return false
      h.setState(s, 'working')
      if (turnActive) {
        // OpenCode queues prompts server-side and runs them after the live
        // turn; the platform's steering semantics (#913) fold the text into
        // the conversation either way.
        sendFollowUp(text)
        return true
      }
      sendPrompt(text)
      return true
    },

    // Command discovery (#1429): GET /command is OpenCode's own merged list —
    // built-ins, config-dir command files, and skill-projected commands
    // (probed) — normalized to the platform DTO. Cached: the list is fixed at
    // server start (config and skills load once), and OpenCode publishes no
    // change event.
    async listCommands() {
      if (latestCommands === null) {
        const raw = await server.request('GET', '/command')
        latestCommands = normalizeCommandList((Array.isArray(raw) ? raw : []).map((c) => ({
          name: c?.name,
          description: c?.description,
          // OpenCode models argument hints as a string array ("$ARGUMENTS",
          // positional names); the platform DTO carries one hint string.
          argument_hint: Array.isArray(c?.hints) ? c.hints.join(' ') : '',
        })))
      }
      return latestCommands.map((command) => ({ ...command }))
    },

    // Structured invocation (#1429) over the native endpoint: OpenCode
    // renders the command template server-side and runs it as an ordinary
    // turn (busy → parts → idle, probed), so the platform turn machinery
    // needs no special casing beyond opening the bookkeeping here. The
    // endpoint is SYNCHRONOUS — it responds only when the turn ends — so it
    // is fired without awaiting, like prompt_async; the SSE stream stays the
    // one source of turn truth. An unknown name is pre-resolved to a clean
    // 400: the raw endpoint answers an opaque 500 (probed).
    async invokeCommand({ command, arguments: argumentsText, model, pendingContext }) {
      const commands = await this.listCommands()
      const resolved = resolveCommand(commands, command)
      if (!resolved) {
        const available = commands.map((item) => item.name)
        const e = new Error(
          `unknown command '${command}'${available.length ? ` (available: ${available.join(', ')})` : ''}`,
        )
        e.status = 400
        throw e
      }
      if (closed || finished) return null
      h.setState(s, 'working')
      const myGen = abortGen
      lastPromptGen = myGen
      resetTurnState()
      turnActive = true
      const args = typeof argumentsText === 'string' ? argumentsText.trim() : ''
      // Pending operator-shell context rides `arguments`: the renderer puts
      // it wherever $ARGUMENTS sits, and APPENDS it to templates without one
      // (probed) — so it reaches the model either way, matching how claude
      // trails it after the slash invocation.
      const context = Array.isArray(pendingContext) && pendingContext.length > 0
        ? pendingContext.join('\n\n')
        : ''
      const effectiveArgs = [args, context].filter(Boolean).join('\n\n')
      const modelID = (typeof model === 'string' && model) || spec.model || ''
      server.request('POST', `/session/${ocSessionId}/command`, {
        command: resolved.name,
        arguments: effectiveArgs,
        // String form here, unlike prompt_async's object (probed): the
        // command body's model field is "provider/model".
        ...(modelID ? { model: `${OPENCODE_PROVIDER_ID}/${modelID}` } : {}),
      }).catch((err) => {
        if (abortGen !== myGen || finished) return
        turnActive = false
        releaseControl()
        chain(() => fail(err))
      })
      return {
        command: resolved.name,
        visible: commandPrompt(command, argumentsText),
      }
    },

    async interrupt() {
      const myGen = ++abortGen
      // Pending gate promises first (the pi deadlock, learned once): the
      // server holds the tool paused on the ask, and each cancelled promise
      // reply-rejects to OpenCode below, releasing it.
      h.cancelPendingPermissions(s, 'interrupted')
      for (const askId of [...openAsks]) {
        openAsks.delete(askId)
        server.request('POST', `/session/${ocSessionId}/permissions/${encodeURIComponent(askId)}`,
          { response: 'reject' }, { timeoutMS: TEARDOWN_TIMEOUT_MS })
          .catch((err) => h.log(`opencode: interrupt ask-reject failed: ${err?.message || err}`))
      }
      turnActive = false
      try {
        await server.request('POST', `/session/${ocSessionId}/abort`, {}, { timeoutMS: TEARDOWN_TIMEOUT_MS })
      } catch (err) {
        h.log(`opencode interrupt failed: ${err?.message || err}`)
      }
      await h.syncToDisk()
      releaseControl()
      if (!finished && abortGen === myGen && !turnActive) h.setState(s, 'idle')
    },

    async setPermissionMode(newMode) {
      if (!SUPPORTED_PERMISSION_MODES.has(newMode)) {
        const e = new Error(`the opencode harness supports permission modes 'default' and 'bypassPermissions', not '${newMode}'`)
        e.status = 400
        throw e
      }
      // The gate consults `mode` at ask time, so the switch covers the
      // in-flight turn too — claude/pi/codex semantics.
      mode = newMode
    },

    beginEnd() {
      closed = true
      if (!turnActive) chain(finish)
      // else the turn's result emit finishes the wind-down.
    },

    async shutdownStop() {
      closed = true
      abortGen++
      turnActive = false
      // Server shutdown cancels pending permissions before calling us.
      try {
        await server.request('POST', `/session/${ocSessionId}/abort`, {}, { timeoutMS: TEARDOWN_TIMEOUT_MS })
      } catch { /* best-effort */ }
      chain(finish)
      await serial
    },
  }

  // sendFollowUp exists as a named function for symmetry with sendPrompt but
  // must not reset the live turn's bookkeeping: the queued prompt joins the
  // SAME platform turn (one sdk.result), matching how the CP counts results.
  function sendFollowUp(text) {
    const myGen = abortGen
    lastPromptGen = myGen
    server.request('POST', `/session/${ocSessionId}/prompt_async`, {
      parts: [{ type: 'text', text }],
      ...(spec.model ? { model: { providerID: OPENCODE_PROVIDER_ID, modelID: spec.model } } : {}),
    }).catch((err) => {
      if (abortGen !== myGen || finished) return
      chain(() => fail(err))
    })
  }
}
