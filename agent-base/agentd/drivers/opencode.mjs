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
import { OpenCodeServer, OpenCodeHTTPError } from './opencode-client.mjs'
import {
  OPENCODE_PROVIDER_ID,
  classifyOpenCodeError,
  gateInputFor,
  initPayload,
  isReservedMCPServer,
  partialPayload,
  reasoningPayload,
  resultPayload,
  textPayload,
  toolResultPayload,
  toolUsePayload,
} from './opencode-translate.mjs'

// Bounded teardown (the codex rule): a wedged server must not hang
// /interrupt or SIGTERM shutdown; turn-carrying calls stay unbounded.
const TEARDOWN_TIMEOUT_MS = 10_000

// The permission modes this harness can host, exported for the registry
// (#1160 rule: the table cannot disagree with construction).
export const SUPPORTED_PERMISSION_MODES = new Set(['default', 'bypassPermissions'])

// The permission config handed to the child. Everything the platform gates is
// 'ask'; the driver answers the asks — instantly in bypassPermissions (and
// under a run's auto-approve policy), via the platform gate in Ask mode. One
// mechanism for both modes is what lets a mid-session mode switch apply at
// the very next ask with no server-side reconfiguration. Keys not listed keep
// OpenCode's defaults (reads allow; doom_loop/external_directory ask — those
// asks flow through the same gate).
const GATED_PERMISSIONS = { bash: 'ask', edit: 'ask', webfetch: 'ask', websearch: 'ask' }

export async function createOpenCodeDriver(s, spec, h) {
  const home = process.env.HOME || '/home/agent'
  const cwd = spec.cwd || home

  let mode = spec.permission_mode || 'bypassPermissions'
  if (!SUPPORTED_PERMISSION_MODES.has(mode)) {
    const e = new Error(`the opencode harness supports permission modes 'default' and 'bypassPermissions', not '${mode}'`)
    e.status = 400
    throw e
  }

  // Connector tools need the #1392 bridge; refusing beats a silently missing
  // toolset (the pi #1063 stopgap, removed the same way). The reserved
  // platform server is survivable and is skipped with a log instead.
  for (const slug of Object.keys(spec.mcp_servers || {})) {
    if (isReservedMCPServer(slug)) {
      h.log(`opencode: platform server '${slug}' tools are not wired yet; skipping`)
      continue
    }
    const e = new Error('connector tools are not yet supported on the opencode harness')
    e.status = 400
    throw e
  }

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
  childEnv.OPENCODE_PERMISSION = JSON.stringify(GATED_PERMISSIONS)

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
  let turnStartMS = 0
  let turnError = null
  let turnResultEmitted = false
  let lastText = '' // the newest finished text part — the run summary
  let lastTokens = null // the last assistant message's token breakdown
  let costNow = 0 // OpenCode's session-cumulative cost, tracked from message.updated
  let baselineCost = 0 // cumulative cost at resume; see resultPayload's contract
  // Tool parts mutate in place; remember what was already emitted so a
  // re-delivered update cannot double-render (SSE reconnect replays nothing,
  // but updates for one part legitimately arrive many times).
  const toolEmitted = new Map() // callID -> 'use' | 'result'
  // Text parts stream by growing in place: keep the emitted length per part
  // for delta extraction, and the full text for the boundary flush.
  const textParts = new Map() // partID -> {text, emittedLen, flushed}
  // OpenCode ask id -> platform pending entry exists (the ask id IS the
  // platform request_id); tracked to reply-reject on interrupt/shutdown.
  const openAsks = new Set()

  const currentModel = () => spec.model || ''

  // flushText emits accumulated text parts as full assistant messages, in
  // part order of arrival. Called at the boundaries a text block is known
  // complete: a tool part appears, or the turn ends.
  function flushText() {
    for (const [, t] of textParts) {
      if (t.flushed || !t.text) continue
      t.flushed = true
      s.pusher.emit('sdk.assistant', textPayload(t.text, currentModel()))
    }
  }

  async function emitResult(subtype) {
    if (finished || turnResultEmitted) return
    turnResultEmitted = true
    flushText()
    const durationMS = turnStartMS ? Date.now() - turnStartMS : 0
    // The session row is the durable cumulative source; the tracked value is
    // the fallback when the server is already unreachable (child died — the
    // fail path emits no result anyway, but a racing idle should not throw).
    let cost = costNow
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
      usage: lastTokens ? {
        input_tokens: lastTokens.input ?? 0,
        output_tokens: lastTokens.output ?? 0,
        cache_read_input_tokens: lastTokens.cache?.read ?? 0,
        cache_creation_input_tokens: lastTokens.cache?.write ?? 0,
      } : undefined,
    }
    // Durability before observability: the CP tears the VM down on sdk.result
    // for session-plane runs (#888); the session db must survive that.
    await h.syncToDisk()
    s.pusher.emit('sdk.result', resultPayload({
      subtype,
      resultText: subtype === 'success' ? lastText : String(turnError?.message || turnError?.name || 'turn failed'),
      costUSD,
      tokens: lastTokens,
      numTurns: 1,
      durationMS,
    }))
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
    await h.syncToDisk()
    s.state = 'ended'
    s.pusher.emit('session.ended', { sdk_session_id: s.sdkSessionId, last_result: s.lastResult })
  }

  async function fail(err) {
    if (finished) return
    finished = true
    server.close()
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
    // Run policy: auto-approve everything except escalated connector tools
    // (#731). Native tools never carry the mcp__ prefix, so today this
    // auto-approves them all; bridged connector tools arrive with #1392.
    if (spec.auto_approve && !h.isEscalatedTool(ask.permission ?? '', spec.escalate_servers)) {
      return reply('once')
    }
    s.pusher.emit('permission.request', {
      request_id: askId,
      tool_name: ask.permission ?? '',
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
          // part.updated diffing below covers builds that do not.
          const partID = props.partID ?? props.part?.id
          const delta = props.delta ?? ''
          const t = partID ? textParts.get(partID) : null
          if (t && typeof delta === 'string' && delta) {
            t.text += delta
            t.emittedLen = t.text.length
            const p = partialPayload(delta)
            if (p) s.pusher.emit('sdk.partial', p, { ephemeral: true })
          }
          break
        }

        case 'message.part.updated': {
          const part = props.part
          if (!part) break
          if (part.type === 'text') {
            let t = textParts.get(part.id)
            if (!t) {
              t = { text: '', emittedLen: 0, flushed: false }
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
            // Text preceding a tool call is complete once the call appears.
            if (!stage) flushText()
            if ((status === 'running' || status === 'pending') && !stage) {
              toolEmitted.set(callID, 'use')
              s.pusher.emit('sdk.assistant', toolUsePayload(part, currentModel()))
            } else if ((status === 'completed' || status === 'error') && stage !== 'result') {
              if (!stage) {
                // Terminal state for a call whose start we never saw (SSE
                // drop): emit the pair so the result is not orphaned.
                s.pusher.emit('sdk.assistant', toolUsePayload(part, currentModel()))
              }
              toolEmitted.set(callID, 'result')
              s.pusher.emit('sdk.user', toolResultPayload(part))
            }
          }
          break
        }

        case 'message.updated': {
          const info = props.info
          if (info?.role !== 'assistant') break
          if (info.tokens && (info.tokens.input || info.tokens.output)) lastTokens = info.tokens
          if (typeof info.cost === 'number' && info.cost > costNow) costNow = info.cost
          if (info.error) turnError = info.error
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
          break
        }

        case 'session.idle': {
          if (!turnActive) break
          const gen = turnGen
          turnActive = false
          chain(async () => {
            // An interrupted turn produces no result (claude parity).
            if (gen !== abortGen) return
            const failed = Boolean(turnError) && !/abort/i.test(String(turnError?.name ?? ''))
            await emitResult(failed ? 'error_during_execution' : 'success')
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
      const e = new Error(`failed to create opencode session: ${err?.message || err}`)
      e.status = 502
      throw e
    }
    if (!ocSessionId) {
      server.close()
      const e = new Error('opencode returned a session without an id')
      e.status = 502
      throw e
    }
  }
  s.sdkSessionId = ocSessionId
  server.startEvents()

  // ---- turn dispatch --------------------------------------------------------
  function sendPrompt(text) {
    const myGen = abortGen
    turnActive = true
    turnGen = myGen
    turnStartMS = Date.now()
    turnError = null
    turnResultEmitted = false
    lastText = ''
    lastTokens = null
    textParts.clear()
    const body = {
      parts: [{ type: 'text', text }],
      // The seeded gateway provider (#1392); the model id is the gateway
      // slug the control plane resolved (state.HarnessModelSlug).
      ...(spec.model ? { model: { providerID: OPENCODE_PROVIDER_ID, modelID: spec.model } } : {}),
      // The question tool has no answer channel on this platform's surfaces
      // yet; without this the model can park a turn on a question nobody
      // sees. Asked-in-text degrades gracefully on both chat and runs.
      tools: { question: false },
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
    server.request('POST', `/session/${ocSessionId}/prompt_async`, {
      parts: [{ type: 'text', text }],
      ...(spec.model ? { model: { providerID: OPENCODE_PROVIDER_ID, modelID: spec.model } } : {}),
      tools: { question: false },
    }).catch((err) => {
      if (abortGen !== myGen || finished) return
      chain(() => fail(err))
    })
  }
}
