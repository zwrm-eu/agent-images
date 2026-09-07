// Codex harness driver (#1088): hosts an OpenAI Codex session by driving
// `codex app-server` over JSON-RPC and translating its notification stream
// into the platform's claude-stream-json-shaped contract (see
// drivers/codex-translate.mjs for the load-bearing consumers).
//
// Differences from the claude and pi drivers, by design:
//  - Out-of-process, but NOT the claude subprocess model: one long-lived
//    app-server child multiplexes threads and turns over stdio. Errors are
//    both API-shaped (typed CodexErrorInfo) and process-shaped (child exit),
//    so classifyCodexError covers both.
//  - The resume handle is the codex THREAD ID — an opaque string, not a path
//    (contrast pi, whose handle is a session file that must be jailed).
//    Rollouts live under ~/.codex/sessions on the workspace volume, so resume
//    survives VM destroy.
//  - Cost is ALWAYS 0: the app-server reports token usage but never cost, and
//    codex agents spend the org's own OPENAI_API_KEY and are not metered
//    (#1089). Usage tokens are still reported for the transcript.
//  - Turn model: `turn/start` opens a turn, `turn/steer` folds a mid-turn
//    message into the live one (claude's steering semantics, #913), and
//    `turn/completed` closes it. Exactly one sdk.result per turn — including
//    failed turns, because sdk.result presence is the run-completion gate.
//  - Permission gate: codex asks over server->client REQUESTS
//    (item/commandExecution/requestApproval, item/fileChange/requestApproval)
//    which block its turn until answered — the same shape as claude's
//    canUseTool, wired to the SAME pending map and HTTP decision endpoint. An
//    unanswered request wedges the turn, so interrupt() must cancel pending
//    gate promises before turn/interrupt (the pi deadlock, learned once).
//  - Codex emits NO approval request for its own MCP tool calls, which is why
//    connectors ride the dynamic-tool bridge rather than codex's native MCP
//    client (#1090) — otherwise escalation would go dark on this harness.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { CodexRPC } from './codex-rpc.mjs'
import {
  approvalPolicyFor,
  classifyCodexError,
  initPayload,
  isToolItem,
  mapEffort,
  messagePayload,
  partialPayload,
  resultPayload,
  sandboxConfigFor,
  sandboxPolicyFor,
  toolResultPayload,
  toolUsePayload,
  usagePayload,
} from './codex-translate.mjs'
// Pure naming/dispatch helpers — no MCP SDK import, so they load unconditionally.
import {
  buildCodexRunTools,
  canonicalToolName,
  codexToolName,
  codexToolSpec,
  mcpResultToCodex,
  toolCallResponse,
  connectorFingerprint,
} from './codex-tools.mjs'
import { permissionDecisionPayload } from '../event-payloads.mjs'
import { todosFromCodexItem } from './todos.mjs'

export function isStaleCodexTurnCompletion(doneId, currentTurnId, turnActive) {
  if (!doneId) return false
  if (currentTurnId) return doneId !== currentTurnId
  // A turn is being opened but turn/started has not supplied its id yet.
  // Any identified completion in this window belongs to a retired turn.
  return turnActive
}

// Teardown calls are bounded: a live-but-wedged app-server must not hang
// /interrupt forever, nor hold SIGTERM shutdown past the daemon's own deadline
// into a SIGKILL with dirty pages. Turn-carrying calls stay unbounded — a turn
// legitimately takes minutes.
const TEARDOWN_TIMEOUT_MS = 10_000

// The permission modes this harness can host. Exported so the server's driver
// registry (drivers/registry.mjs) can enforce the same set at session create
// and on the pre-seed stub — a mode accepted there and rejected here would 200
// the request and then kill the session when construction runs (#1160 review).
export const SUPPORTED_PERMISSION_MODES = new Set(['default', 'bypassPermissions'])

// createCodexDriver constructs the driver asynchronously (spawn + initialize +
// thread/start are all round-trips). Throws with .status for client-caused
// failures; the caller owns not publishing a half-built session.
export async function createCodexDriver(s, spec, h) {
  const home = process.env.HOME || '/home/agent'
  const cwd = spec.cwd || home

  let mode = spec.permission_mode || 'bypassPermissions'
  if (!SUPPORTED_PERMISSION_MODES.has(mode)) {
    const e = new Error(`the codex harness supports permission modes 'default' and 'bypassPermissions', not '${mode}'`)
    e.status = 400
    throw e
  }

  // The app-server child — not this daemon — runs the model and the tools, so
  // per-session env (OPENAI_API_KEY above all) goes to the child explicitly.
  // HOME is skipped: overriding it would move ~/.codex out from under the
  // thread ids we hand back as resume handles.
  const childEnv = { ...process.env }
  for (const [k, v] of Object.entries(spec.env || {})) {
    if (k === 'HOME') continue
    childEnv[k] = v
  }

  // ---- credentials ----------------------------------------------------------
  //
  // The app-server does NOT authenticate from the environment. Measured
  // against the pinned binary: with OPENAI_API_KEY set in the child env and no
  // auth.json, every turn fails `401 Unauthorized: Missing bearer or basic
  // authentication in header` — it never even reaches the account. The file is
  // the only mechanism, for BOTH modes, which is why the platform materializes
  // whichever credential the org configured.
  //
  // Two secrets, mirroring the claude harness's API-key-or-subscription pair:
  //
  //   OPENAI_CODEX_AUTH   the whole auth.json from `codex login` — a ChatGPT
  //                        subscription. Written VERBATIM: the record is an
  //                        OAuth bundle (tokens.access_token / refresh_token /
  //                        account_id) that codex renews in place, and a bare
  //                        access token would expire within hours. Passing it
  //                        through unparsed also means a codex release can
  //                        change the record's shape without breaking us.
  //   OPENAI_API_KEY       usage-based billing on the org's own API account.
  //
  // Subscription WINS when both are set: it is capacity the org has already
  // paid for, so a leftover API key cannot quietly start charging.
  //
  // Either value is whatever this VM currently holds — the platform delivers
  // both as boot-time env secrets, so a rotation reaches the agent when its VM
  // next boots, not mid-life. (pi's per-session key is different: that one is
  // platform-owned config the control plane injects into the spec.)
  const codexHome = childEnv.CODEX_HOME || `${home}/.codex`
  const authPath = `${codexHome}/auth.json`
  // Records that WE materialized auth.json, and the DIGEST of exactly what we
  // wrote, so revocation can tell our file from the user's own. Two cases the
  // contents alone cannot separate: a `chatgpt` record may come from the
  // subscription secret or from an interactive `codex login` over SSH, and a
  // record we did write may since have been replaced by the user logging in
  // themselves. Deleting either of those would sign the user out of their own
  // VM, so revocation removes auth.json only when it is byte-for-byte what we
  // last wrote.
  const authMarkerPath = `${codexHome}/.zwrm-auth-source`
  const digest = (text) => createHash('sha256').update(text).digest('hex')
  const writeAuth = async (record, source) => {
    const body = JSON.stringify(record) + '\n'
    await mkdir(codexHome, { recursive: true })
    await writeFile(authPath, body, { mode: 0o600 })
    await writeFile(authMarkerPath, `${source} ${digest(body)}\n`, { mode: 0o600 })
  }
  const subscription = String(spec.env?.OPENAI_CODEX_AUTH || process.env.OPENAI_CODEX_AUTH || '').trim()
  const apiKey = String(spec.env?.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '').trim()

  let subscriptionRecord = null
  if (subscription) {
    try {
      subscriptionRecord = JSON.parse(subscription)
    } catch {
      subscriptionRecord = null
    }
    // Refuse loudly rather than writing something codex cannot read. A
    // malformed record surfaces later as a bare 401 — or as a parse error
    // naming a FILE the operator never wrote — either of which reads as "the
    // harness is broken" and sends them hunting in the wrong place.
    //
    // The checks mirror what codex itself enforces when it reads the file,
    // measured against the pinned 0.153.4 with `codex login status`:
    //   - `tokens` must be an object; a bare token string is rejected with
    //     "invalid type: string, expected struct TokenData";
    //   - `id_token` is MANDATORY ("missing field `id_token`") and is parsed
    //     as a JWT ("invalid ID token format"), because codex reads the
    //     account and plan out of its claims.
    // `last_refresh` is optional, so it is deliberately not required here.
    const t = subscriptionRecord?.tokens
    const idToken = typeof t?.id_token === 'string' ? t.id_token : ''
    const looksJWT = idToken.split('.').length === 3
    if (!subscriptionRecord || typeof subscriptionRecord !== 'object' ||
        !subscriptionRecord.auth_mode || !t || typeof t !== 'object' || Array.isArray(t) ||
        !looksJWT) {
      const e = new Error(
        'OPENAI_CODEX_AUTH is not a codex auth record. It must be the ENTIRE contents of ' +
        '~/.codex/auth.json after `codex login` — an object with auth_mode and a tokens ' +
        'object containing id_token (a JWT), access_token and refresh_token — not a bare token. ' +
        'Set it with: zwrm secrets set OPENAI_CODEX_AUTH "$(jq -c . ~/.codex/auth.json)"',
      )
      e.status = 400
      throw e
    }
  }

  try {
    if (subscriptionRecord) {
      await writeAuth(subscriptionRecord, 'OPENAI_CODEX_AUTH')
    } else if (apiKey) {
      await writeAuth({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }, 'OPENAI_API_KEY')
    } else {
      // Revocation cannot be handled by omission: auth.json lives on the
      // workspace VOLUME, so a record left behind keeps authenticating on a
      // credential the org has since deleted — across reboots, for as long as
      // the workspace exists.
      let ours = false
      try {
        const [, recorded] = (await readFile(authMarkerPath, 'utf8')).trim().split(/\s+/)
        ours = Boolean(recorded) && recorded === digest(await readFile(authPath, 'utf8'))
      } catch { /* no marker or no auth.json: nothing of ours to revoke */ }
      if (ours) {
        h.log('codex: no OPENAI_CODEX_AUTH or OPENAI_API_KEY is configured; removing the platform-written login')
        await rm(authPath, { force: true })
        await rm(authMarkerPath, { force: true })
      } else {
        // Either the user logged in themselves, or codex refreshed the tokens
        // in place. Both make the file theirs to keep.
        await rm(authMarkerPath, { force: true })
      }
    }
  } catch (err) {
    // Not fatal on its own: an existing login may still carry the session.
    // Failing here would turn a recoverable state into a hard refusal.
    h.log(`codex: could not update ${authPath}: ${err?.message || err}`)
  }

  // Dynamic tools: connector + platform tools are executed by THIS daemon, so
  // every call passes through the same permission gate the claude and pi
  // harnesses use. Codex's native MCP client would bypass it — codex raises no
  // approval request for its own MCP calls, which would take escalation (#731)
  // dark on this harness alone. See codex-tools.mjs.
  //
  // Populated AFTER the app-server handshake: connecting first would leave live
  // MCP clients (and their minted gateway tokens) orphaned if the spawn threw,
  // which is why pi builds its bridge last too.
  const toolSpecs = []
  const toolHandlers = new Map() // wire name -> async (args, signal) => DynamicToolCallResponse
  let closeBridge = () => {}

  let closed = false
  let finished = false
  let rpc = null
  // abortGen invalidates in-flight work: a turn started before an interrupt
  // must not emit a result (claude parity), and a request rejection caused by
  // our own abort must not fail the session.
  let abortGen = 0
  // serial orders async reactions (result emits, finish) behind the
  // synchronous notification callback, preserving event order on the wire.
  let serial = Promise.resolve()
  const chain = (fn) => {
    serial = serial.then(fn).catch((err) => h.log(`codex session ${s.id} reaction failed: ${err?.stack || err}`))
    return serial
  }

  // ---- turn bookkeeping -----------------------------------------------------
  // Aborted by interrupt(), and carried into every bridged tool call so an
  // in-flight connector request is cancelled with the turn. mcp-bridge names
  // this invariant load-bearing: without it, an interrupted call runs to the
  // SDK's own timeout and its side effect — a message posted, an issue opened —
  // lands after the user cancelled it.
  let toolAbort = new AbortController()
  let turnActive = false
  let currentTurnId = null
  // Messages that arrived after turn/start was sent but before turn/started
  // told us the id to steer against.
  const pendingSteers = []
  let turnStartMS = 0
  // The abort generation the turn was opened in, captured when the turn is
  // REQUESTED and carried onto it when turn/started lands. Comparing the
  // generation at completion against the one at start is what makes an
  // interrupted turn emit no result (claude parity); reading abortGen when the
  // notification happens to arrive would always match — defeating the check
  // and re-arming a turn the interrupt already retired.
  let turnGen = 0
  // One entry per turn/start still awaiting its turn/started, oldest first,
  // each carrying the abort generation it was REQUESTED in. Turns run serially
  // on a thread — codex does not open the next one until the current turn ends
  // — so turn/started notifications arrive in request order and the oldest
  // unmatched entry is the one a given notification belongs to.
  //
  // A single shared "generation of the last request" cannot do this job: when
  // an interrupt retires a turn that has no id yet, cancellation is deferred to
  // turn/started, but the NEXT startTurn overwrites that shared value — so the
  // retired turn's late turn/started compares equal and is adopted as the live
  // turn, still running its tool calls while the new message is steered into it.
  //
  // The pairing is deliberately made HERE, synchronously inside the
  // notification handler, rather than from the turn/start response: responses
  // resolve on the microtask queue, so a batch of lines read together would
  // apply the turn's opening state after its own content had already streamed.
  const openingTurns = []
  let lastAgentText = ''
  let lastUsage = null
  let turnError = null
  // Codex request id -> platform permission request id, so a withdrawn
  // approval (serverRequest/resolved) can release the human waiting on it.
  const gateByCodexRequest = new Map()
  // Exactly one result per turn: a turn that both errors and completes must
  // not emit twice. A flag rather than an id comparison, because a turn whose
  // id we never learned would compare equal (null === null) to the next one.
  let turnResultEmitted = false
  // The model the thread actually resolved to. Declared before the
  // notification handler can reference it, and refined after thread/start.
  let currentModel = spec.model || ''

  async function emitResult(subtype) {
    if (finished || turnResultEmitted) return
    turnResultEmitted = true
    const durationMS = turnStartMS ? Date.now() - turnStartMS : 0
    s.lastResult = {
      subtype,
      duration_ms: durationMS,
      num_turns: 1,
      total_cost_usd: 0,
      // The MAPPED shape, matching sdk.result and what the other drivers
      // store: session.ended and /snapshot expose this verbatim.
      usage: usagePayload(lastUsage),
    }
    // Durability before observability: the CP tears the VM down on sdk.result
    // for session-plane runs (#888); the codex rollout must survive that.
    await h.syncToDisk()
    s.pusher.emit('sdk.result', resultPayload({
      subtype,
      resultText: subtype === 'success' ? lastAgentText : String(turnError?.message || 'turn failed'),
      usage: lastUsage,
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
    rpc?.close()
    closeBridge()
    await h.syncToDisk()
    s.state = 'ended'
    s.pusher.emit('session.ended', { sdk_session_id: s.sdkSessionId, last_result: s.lastResult })
  }

  async function fail(err) {
    if (finished) return
    finished = true
    rpc?.close()
    closeBridge()
    h.log(`codex session ${s.id} failed: ${err?.stack || err}`)
    const c = classifyCodexError(err)
    await h.syncToDisk()
    s.state = 'error'
    s.pusher.emit('session.error', { message: c.message, cause: c.cause, detail: c.detail })
  }

  // ---- permission gate ------------------------------------------------------
  //
  // Returns true to allow. Consults `mode` at call time so a mid-session mode
  // switch applies to the next request — matching claude/pi semantics.
  async function gate(toolName, input, toolUseId, codexRequestId, kind) {
    // After /end, the in-flight turn may still reach for another tool; a new
    // pending prompt would wedge the wind-down forever, so deny immediately
    // (no permission.request — nobody is left to answer it).
    if (s.ending) return { allow: false, message: 'session ended' }
    if (mode === 'bypassPermissions') return { allow: true }
    if (spec.auto_approve && !h.isEscalatedTool(toolName, spec.escalate_servers)) {
      return { allow: true }
    }
    const requestId = randomUUID()
    s.pusher.emit('permission.request', {
      request_id: requestId,
      tool_name: toolName,
      input,
      tool_use_id: toolUseId,
      ...(kind ? { kind } : {}),
    })
    h.setState(s, 'blocked')
    // Resolved by POST /permissions/{request_id} through the shared pending
    // map — or canceled by interrupt()/end/shutdown, which MUST resolve it:
    // codex keeps the turn paused on this reply, so an unresolved promise
    // deadlocks turn/interrupt.
    // Remembered so a `serverRequest/resolved` withdrawal can find and
    // release this promise; codex discarding the request is the one case
    // where no reply will ever be read.
    if (codexRequestId !== undefined) gateByCodexRequest.set(codexRequestId, requestId)
    let decision
    try {
      decision = await new Promise((resolve) => {
        s.pending.set(requestId, { resolve, toolName, input, ts: Date.now() })
      })
    } finally {
      if (codexRequestId !== undefined) gateByCodexRequest.delete(codexRequestId)
    }
    if (decision.behavior === 'allow') {
      return { allow: true, updatedInput: decision.updatedInput }
    }
    return { allow: false, message: decision.message || 'denied by user' }
  }

  async function onRequest(method, params, codexRequestId) {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const input = { command: params?.command ?? '', cwd: params?.cwd ?? '', reason: params?.reason ?? '' }
        const d = await gate('shell', input, params?.itemId, codexRequestId)
        return { decision: d.allow ? 'accept' : 'decline' }
      }
      case 'item/fileChange/requestApproval': {
        const input = { reason: params?.reason ?? '', grant_root: params?.grantRoot ?? '' }
        const d = await gate('apply_patch', input, params?.itemId, codexRequestId)
        return { decision: d.allow ? 'accept' : 'decline' }
      }
      case 'item/permissions/requestApproval': {
        // The profile-shaped escalation (codex >= 0.145): the model asks to
        // widen network/filesystem access rather than to run one command.
        // Both the grant and the refusal are the SAME shape — an EMPTY
        // permissions object grants nothing — so a denial here is a
        // well-formed answer, not a protocol error.
        const requested = params?.permissions ?? {}
        const input = {
          reason: params?.reason ?? '',
          cwd: params?.cwd ?? '',
          requested_permissions: requested,
        }
        const d = await gate('request_permissions', input, params?.itemId, codexRequestId)
        if (!d.allow) return { permissions: {}, scope: 'turn' }
        // Grant what the APPROVER approved, not what the model asked for: a
        // decider may narrow the profile (dropping `network`, say) by
        // returning updated_input, and honouring the original request would
        // grant more than the human agreed to. Absent an override, the
        // request stands as-is — never wider.
        const approved = d.updatedInput?.requested_permissions ?? requested
        return {
          permissions: {
            ...(requested.network && approved.network ? { network: approved.network } : {}),
            ...(requested.fileSystem && approved.fileSystem ? { fileSystem: approved.fileSystem } : {}),
          },
          // Grant for this turn only: a session-scoped widening would outlive
          // the approval the human actually gave.
          scope: 'turn',
        }
      }
      case 'item/tool/requestUserInput': {
        // Codex's AskUserQuestion twin. An unattended run has no one to
        // answer, and replying with empty answers would let the model
        // continue on fabricated certainty (the claude-code #30983 failure
        // mode) — so refuse outright and let codex proceed without it.
        if (!spec.interactive) {
          throw new Error('this session is unattended; ask no questions and proceed with your best judgement')
        }
        const d = await gate(
          'request_user_input',
          { questions: params?.questions ?? [] },
          params?.itemId,
          codexRequestId,
          'question',
        )
        const answers = d.allow ? d.updatedInput?.answers : null
        if (!answers || typeof answers !== 'object') {
          // Approving without supplying answers is not an answer. Refusing is
          // honest; fabricating would not be.
          throw new Error(d.message || 'no answers were supplied')
        }
        return { answers }
      }
      case 'item/tool/call': {
        // A dynamic tool call: this daemon executes it, which is what keeps
        // connector tools inside the platform permission gate.
        const wire = params?.tool ?? ''
        const handler = toolHandlers.get(wire)
        if (!handler) {
          // A tool codex offers that we can no longer serve. Reachable on a
          // resumed thread: codex persists the tool set declared at
          // thread/start and re-offers it, and a connector detached since then
          // leaves an offer with no handler behind it. Answer with a failure —
          // never silently, and never with a fabricated result.
          h.log(`codex: refusing call to unknown dynamic tool ${wire}`)
          return toolCallResponse(
            `The tool ${wire} is no longer available in this session. Do not retry it; continue without it or report that it is unavailable.`,
            false,
          )
        }
        // The gate matches the CANONICAL name — codex reserves `mcp__`, so the
        // wire name differs, but escalation policy must not.
        const canonical = canonicalToolName(wire)
        const args = params?.arguments ?? {}
        const d = await gate(canonical, args, params?.callId, codexRequestId)
        if (!d.allow) {
          return toolCallResponse(d.message || 'denied by user', false)
        }
        try {
          return await handler(d.updatedInput ?? args, toolAbort.signal)
        } catch (err) {
          // A thrown execute is a failed tool call, not a failed session:
          // the model sees the error and can act on it, exactly as on the
          // claude and pi harnesses.
          return toolCallResponse(String(err?.message || err), false)
        }
      }
      default:
        // Never auto-approve a request shape this build does not understand —
        // an unknown server request is refused, loudly and safely.
        throw new Error(`unsupported codex server request ${method}`)
    }
  }

  // ---- notifications --------------------------------------------------------
  function onNotification(method, params) {
    try {
      switch (method) {
        case 'turn/started': {
          const startedId = params?.turn?.id ?? null
          // Judge this turn by the generation of the request that opened it,
          // not by the generation in force when the notification happens to
          // land. An interrupt that arrived while the turn was still opening
          // had no id to cancel; this is where that cancellation happens.
          const opening = openingTurns.shift()
          if (!opening || opening.gen !== abortGen) {
            h.log('codex: cancelling a turn that was interrupted while opening')
            if (startedId) {
              rpc.request('turn/interrupt', { threadId, turnId: startedId }, { timeoutMS: TEARDOWN_TIMEOUT_MS })
                .catch((err) => h.log(`codex late interrupt failed: ${err?.message || err}`))
            }
            break
          }
          turnActive = true
          currentTurnId = startedId
          turnStartMS = Date.now()
          turnGen = opening.gen
          turnError = null
          turnResultEmitted = false
          lastAgentText = ''
          // Per-turn, or a turn that reports no usage would inherit the
          // previous turn's token counts.
          lastUsage = null
          h.setState(s, 'working')
          flushSteers()
          break
        }

        case 'item/agentMessage/delta': {
          const p = partialPayload(params)
          if (p) s.pusher.emit('sdk.partial', p, { ephemeral: true })
          break
        }

        case 'item/started': {
          const item = params?.item
          // Tool items render as a tool_use block now and a tool_result when
          // they complete; message items emit once, on completion.
          if (isToolItem(item)) s.pusher.emit('sdk.assistant', toolUsePayload(item, currentModel))
          break
        }

        case 'item/completed': {
          const item = params?.item
          if (isToolItem(item)) {
            s.pusher.emit('sdk.user', toolResultPayload(item))
          } else if (item?.type === 'agentMessage') {
            lastAgentText = item.text ?? ''
            s.pusher.emit('sdk.assistant', messagePayload(item, currentModel))
          } else if (item?.type === 'reasoning') {
            s.pusher.emit('sdk.assistant', messagePayload(item, currentModel))
          } else if (item?.type === 'todoList') {
            // Codex's plan tool. Not a transcript item — it feeds the
            // platform task list (#1424) the same way claude's TodoWrite
            // does, as a wholesale todo.updated snapshot. A shape this
            // build cannot read is logged, not swallowed: the pin will
            // move, and a silently dead task list is invisible.
            const todos = todosFromCodexItem(item)
            if (todos) s.pusher.emit('todo.updated', { todos })
            else h.log('codex: todoList item with unrecognized shape dropped')
          } else if (item?.type) {
            // ThreadItem is a growing union (plan, collabAgentToolCall,
            // imageGeneration, contextCompaction, …). Dropping a shape this
            // build cannot render beats putting an unreadable payload in the
            // durable timeline — but it must not be silent, because the pin
            // will move and a dropped TOOL CALL would be invisible.
            h.log(`codex: unhandled thread item type ${item.type}`)
          }
          break
        }

        case 'thread/tokenUsage/updated':
          // `last` is this turn's usage; `total` is thread-cumulative.
          lastUsage = params?.tokenUsage?.last ?? null
          break

        case 'turn/completed': {
          // A completion for a turn that is no longer the live one is stale —
          // an interrupted turn's completion can arrive after the next turn
          // has opened. Acting on it would clear the LIVE turn's state and
          // flip the session idle mid-turn, and the CP reads idle + any
          // recorded result as "run complete" and tears the VM down under a
          // working agent.
          const doneId = params?.turn?.id ?? null
          if (isStaleCodexTurnCompletion(doneId, currentTurnId, turnActive)) {
            h.log(`codex: ignoring turn/completed for stale turn ${doneId}`)
            break
          }
          const status = params?.turn?.status
          if (status === 'failed' && !turnError) turnError = params?.turn?.error ?? null
          const gen = turnGen
          turnActive = false
          currentTurnId = null
          chain(async () => {
            // An interrupted turn produces no result (claude parity) —
            // whether our own interrupt retired its generation, or codex
            // reports the interrupted status itself.
            if (gen !== abortGen || status === 'interrupted') return
            await emitResult(status === 'failed' ? 'error_during_execution' : 'success')
          })
          break
        }

        case 'error': {
          // willRetry means codex is retrying this turn itself — not a result.
          if (params?.willRetry) {
            h.log(`codex retrying after error: ${params?.error?.message ?? ''}`)
            break
          }
          // Same staleness guard as turn/completed: an error belonging to a
          // turn that has already been superseded must not clear the live one.
          const errTurnId = params?.turnId ?? null
          if (errTurnId && currentTurnId && errTurnId !== currentTurnId) {
            h.log(`codex: ignoring error for stale turn ${errTurnId}`)
            break
          }
          turnError = params?.error ?? null
          const wasActive = turnActive
          const gen = turnGen
          turnActive = false
          currentTurnId = null
          chain(async () => {
            if (gen !== abortGen) return
            // A failed turn must still produce a result: sdk.result presence
            // is the run-completion gate, so swallowing this would wedge an
            // autonomous run until the reaper times it out.
            if (wasActive) await emitResult('error_during_execution')
            else h.log(`codex error outside a turn: ${params?.error?.message ?? ''}`)
          })
          break
        }

        case 'serverRequest/resolved': {
          // Codex withdrew a server->client request it no longer needs
          // answered. Without this the gate promise stays parked forever: the
          // session sits 'blocked', the run sits in needs_attention until the
          // reaper, and a human's eventual approval answers a request nobody
          // is listening to.
          const gateID = gateByCodexRequest.get(params?.requestId)
          if (gateID !== undefined) {
            gateByCodexRequest.delete(params?.requestId)
            const pending = s.pending.get(gateID)
            if (pending) {
              s.pending.delete(gateID)
              s.pusher.emit('permission.decision', permissionDecisionPayload(gateID, {
                behavior: 'cancel',
                message: 'withdrawn by codex',
              }))
              pending.resolve({ behavior: 'deny', message: 'withdrawn', interrupt: false })
              h.resumeIfUnblocked(s)
            }
          }
          break
        }

        case 'thread/status/changed':
          if (params?.status?.type === 'systemError') {
            chain(() => fail(new Error('codex reported a system error')))
          }
          break

        default:
          // codex-internal notifications (diffs, account, fuzzy search,
          // realtime) drive nothing here; forwarding untranslated shapes
          // would put unreadable payloads in the durable timeline.
      }
    } catch (err) {
      h.log(`codex event translation failed (${method}): ${err?.stack || err}`)
    }
  }

  // The app-server dying is terminal for the session either way; a wind-down
  // already in progress ends cleanly rather than reporting a failure it was
  // about to cause itself.
  function onExit(err) {
    if (finished) return
    chain(() => (closed ? finish() : fail(err)))
  }

  // ---- construction ---------------------------------------------------------
  rpc = new CodexRPC({
    // The image pins `codex` on PATH; the override exists so the driver can be
    // exercised against a fake app-server (test/codex-driver.test.mjs) and so
    // an operator can point at a specific build without rebuilding the image.
    command: process.env.ZWRM_CODEX_BIN || 'codex',
    env: childEnv,
    cwd,
    log: h.log,
    onNotification,
    onRequest,
    onExit,
  })

  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'zwrm-agentd', title: 'zwrm', version: h.VERSION },
      // experimentalApi opts into the dynamicTools field the connector bridge
      // and run tools need (#1090); harmless before they are wired.
      capabilities: { experimentalApi: true },
    })
    rpc.notify('initialized', {})
  } catch (err) {
    rpc.close()
    closeBridge()
    const e = new Error(`failed to start codex app-server: ${err?.message || err}`)
    e.status = 502
    throw e
  }

  if (Object.keys(spec.mcp_servers || {}).length > 0) {
    // Imported lazily: the bridge pulls in the MCP SDK, and a session with no
    // servers must not pay for it (nor require it to be installed).
    const { connectServers } = await import('./mcp-bridge.mjs')
    const bridge = await connectServers(spec.mcp_servers, h.log)
    closeBridge = bridge.close
    for (const entry of bridge.entries) {
      for (const t of entry.tools) {
        toolSpecs.push(codexToolSpec(entry.slug, t))
        toolHandlers.set(codexToolName(entry.slug, t.name),
          async (args, signal) => mcpResultToCodex(await entry.call(t.name, args, signal)))
      }
    }
  }
  if (!spec.interactive) {
    for (const rt of buildCodexRunTools(s, h)) {
      toolSpecs.push(rt.spec)
      toolHandlers.set(rt.spec.name, rt.run)
    }
  }

  // Point codex's own skills loader at the directory the platform seeds
  // (agentsession.SeedSkills writes ~/.claude/skills). Codex HAS a full
  // SKILL.md loader — the issue's premise that it does not is wrong — so this
  // is wiring, not substitution: verified against the pinned binary, a skill
  // in that directory appears in skills/list as scope=user, enabled.
  //
  // FAIL LOUD, deliberately. This is one local RPC to a child process we just
  // spawned; the realistic way it fails is a pin bump whose app-server renamed
  // or dropped the method. Swallowing that would put the operator back in the
  // exact state the removed "skills are not loaded on codex" notice existed to
  // prevent: every skill green in the dashboard, a run that silently ignored
  // them, and no error on any surface. A refused session start is visible and
  // recoverable; a session that quietly forgets its skills is neither.
  try {
    await rpc.request('skills/extraRoots/set', { extraRoots: [`${home}/.claude/skills`] },
      { timeoutMS: TEARDOWN_TIMEOUT_MS })
  } catch (err) {
    rpc.close()
    closeBridge()
    const e = new Error(`codex rejected the platform skills directory: ${err?.message || err}`)
    e.status = 502
    throw e
  }

  const policy = approvalPolicyFor(mode)
  const threadParams = {
    cwd,
    approvalPolicy: policy.approvalPolicy,
    sandbox: policy.sandbox,
    ...(spec.model ? { model: spec.model } : {}),
    // append_system_prompt (platform instructions + memory block + run
    // preamble) rides developerInstructions: it must ADD to codex's built-in
    // behavior, so baseInstructions — which REPLACES it — is deliberately
    // untouched.
    ...(spec.append_system_prompt ? { developerInstructions: spec.append_system_prompt } : {}),
    config: {
      // Agent workspaces are ordinary directories; codex otherwise refuses to
      // run outside a git repository.
      skip_git_repo_check: true,
      ...sandboxConfigFor(mode),
    },
  }

  // Resume decision. Codex freezes a thread's dynamic tools at creation and
  // re-offers them on resume, so a thread created with a different CONNECTOR
  // set would run the wrong toolset for the rest of its life. The record is
  // keyed BY THREAD, not "the latest one": an explicit resume_session_id may
  // name an older thread, and judging it against a newer thread's record would
  // silently discard the very conversation the caller asked to continue.
  //
  // Unknown threads RESUME. The asymmetry is deliberate: a stale toolset is
  // visible and recoverable — an unknown tool call is answered with a clear
  // failure below, and re-attaching the connector fixes it — whereas a wrong
  // reset destroys conversation context silently and permanently. Only a
  // KNOWN, genuinely different connector set forfeits the thread.
  const fingerprint = connectorFingerprint(spec.mcp_servers)
  const fingerprintPath = `${codexHome}/.zwrm-thread-tools.json`
  const readRecords = async () => {
    try {
      const parsed = JSON.parse(await readFile(fingerprintPath, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  let resumeHandle = spec.resume_sdk_session_id || ''
  if (resumeHandle) {
    const records = await readRecords()
    const recorded = records[resumeHandle]
    if (recorded !== undefined && recorded !== fingerprint) {
      h.log(`codex: connectors changed since thread ${resumeHandle} was created ` +
        `(was "${recorded}", now "${fingerprint}"); starting a fresh thread`)
      resumeHandle = ''
    }
  }

  // dynamicTools is a thread/START-only parameter; passing it to thread/resume
  // is silently ignored (unknown params are), which would look like it worked.
  const startParams = () => (toolSpecs.length > 0 ? { ...threadParams, dynamicTools: toolSpecs } : threadParams)

  let started
  try {
    if (resumeHandle) {
      try {
        started = await rpc.request('thread/resume', { threadId: resumeHandle, ...threadParams })
      } catch (err) {
        // A resume handle that no longer resolves must NOT fail the session.
        // The rollout lives on the workspace volume, so it can legitimately go
        // missing — an archive that fails to rehydrate, a restored snapshot, a
        // volume replaced under a keyed workspace — while the control plane
        // still holds the handle and nothing clears it. Failing here would
        // wedge that workspace key permanently: every session and every run on
        // it would fail identically, forever, until an operator deleted the
        // volume.
        //
        // Starting fresh is what pi does when its session file is missing, and
        // it self-heals: the init event carries the new thread id, which the
        // control plane stamps over the dead handle. The cost is the model's
        // in-thread context; the platform transcript is kept control-plane side
        // and is unaffected.
        h.log(`codex: resume handle ${resumeHandle} did not resolve (${err?.message || err}); starting a fresh thread`)
        started = await rpc.request('thread/start', startParams())
      }
    } else {
      started = await rpc.request('thread/start', startParams())
    }
  } catch (err) {
    rpc.close()
    closeBridge()
    // Reached only when a FRESH start failed too, so this is never a stale
    // handle: auth, spawn, or protocol — ours to report as a bad gateway.
    const e = new Error(`failed to start codex thread: ${err?.message || err}`)
    e.status = 502
    throw e
  }

  const threadId = started?.thread?.id || ''
  if (!threadId) {
    rpc.close()
    closeBridge()
    const e = new Error('codex app-server returned a thread without an id')
    e.status = 502
    throw e
  }
  // Record this thread's connector set so a later session can judge THIS
  // thread rather than whichever one happened to be created last. Bounded:
  // workspaces are long-lived and a thread per session would grow unbounded.
  try {
    const records = await readRecords()
    records[threadId] = fingerprint
    const keys = Object.keys(records)
    const MAX_RECORDS = 50
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_RECORDS))) delete records[stale]
    await writeFile(fingerprintPath, JSON.stringify(records) + '\n', { mode: 0o600 })
  } catch (err) {
    // A missing record reads as "unknown", which resumes — the safe direction.
    h.log(`codex: could not record the thread connector set: ${err?.message || err}`)
  }
  s.sdkSessionId = threadId
  currentModel = started?.model || spec.model || ''

  // ---- turn dispatch --------------------------------------------------------
  function textInput(text) {
    return { type: 'text', text, text_elements: [] }
  }

  function flushSteers() {
    if (!currentTurnId) return
    while (pendingSteers.length > 0) {
      const text = pendingSteers.shift()
      sendSteer(text)
    }
  }

  function sendSteer(text, retriesLeft = 1) {
    const myGen = abortGen
    const expectedTurnId = currentTurnId
    if (!expectedTurnId) {
      startTurn(text)
      return
    }
    rpc.request('turn/steer', { threadId, input: [textInput(text)], expectedTurnId })
      .catch((err) => {
        if (abortGen !== myGen || finished) return
        // ANY steer failure is treated as "the turn ended under us" and
        // retried as a new turn. Matching on the error text instead would
        // fail the whole SESSION whenever that wording drifts — losing a
        // conversation over a message that arrived a millisecond late.
        if (retriesLeft > 0) {
          h.log(`codex steer failed, delivering as a new turn: ${err?.message || err}`)
          turnActive = false
          currentTurnId = null
          startTurn(text)
          return
        }
        chain(() => fail(err))
      })
  }

  function startTurn(text) {
    const myGen = abortGen
    turnActive = true
    // turn/started supplies the id we steer against; until it lands, further
    // messages queue in pendingSteers rather than racing a second turn.
    currentTurnId = null
    turnStartMS = Date.now()
    // Claim this request's slot before the request goes out, so the pairing
    // holds however the response and the notification interleave.
    const opening = { gen: myGen }
    openingTurns.push(opening)
    const effort = mapEffort(spec.effort)
    rpc.request('turn/start', {
      threadId,
      input: [textInput(text)],
      ...(spec.model ? { model: spec.model } : {}),
      ...(effort ? { effort } : {}),
      // Both halves of the permission mode ride every turn: the approval
      // policy decides whether codex ASKS, the sandbox policy decides what it
      // may DO. Sending only the former would let a mid-session mode switch
      // move one without the other — stopping the prompts while leaving the
      // sandbox narrow, or vice versa.
      approvalPolicy: approvalPolicyFor(mode).approvalPolicy,
      sandboxPolicy: sandboxPolicyFor(mode, cwd),
    }).then((resp) => {
      // Belt for the ordering between the response and turn/started: adopting
      // the id early lets queued messages steer without waiting.
      if (abortGen !== myGen || finished) return
      if (!currentTurnId && resp?.turn?.id) {
        currentTurnId = resp.turn.id
        flushSteers()
      }
    }).catch((err) => {
      // Release this request's slot unconditionally: no turn/started will ever
      // arrive for a turn/start that failed, and leaving it queued would
      // mis-pair the NEXT turn's notification against this one's generation.
      const at = openingTurns.indexOf(opening)
      if (at >= 0) openingTurns.splice(at, 1)
      if (abortGen !== myGen || finished) return
      turnActive = false
      currentTurnId = null
      chain(() => fail(err))
    })
  }

  function dispatch(text) {
    if (!turnActive) {
      startTurn(text)
      return
    }
    if (currentTurnId) {
      sendSteer(text)
      return
    }
    pendingSteers.push(text)
  }

  return {
    harness: 'codex',

    start() {
      // Mirrors claude's init ordering: session.started is emitted by the
      // caller first, then the init event that carries the resume handle.
      s.pusher.emit('sdk.system', initPayload(threadId, currentModel))
    },

    queueMessage(text) {
      if (closed || finished) return false
      h.setState(s, 'working')
      dispatch(text)
      return true
    },

    async interrupt() {
      const myGen = ++abortGen
      // Codex keeps a turn paused on an unanswered approval reply — cancel
      // pending gate promises first or turn/interrupt waits behind them
      // (emits the same permission.decision cancel events as claude's
      // abort-signal listeners).
      h.cancelPendingPermissions(s, 'interrupted')
      gateByCodexRequest.clear()
      // Cancel in-flight connector calls with the turn, then arm a fresh
      // controller for whatever starts next.
      toolAbort.abort()
      toolAbort = new AbortController()
      // Messages parked while the turn was opening were addressed to the turn
      // the user just cancelled. Leaving them queued replays them into the
      // NEXT turn — after whatever prompt opened it, so the model sees the
      // conversation out of order and acts on an instruction already withdrawn.
      pendingSteers.length = 0
      const turnId = currentTurnId
      turnActive = false
      currentTurnId = null
      // A turn still being opened has no id yet; turn/started cancels it on
      // arrival by comparing against the generation bumped above.
      if (turnId) {
        try {
          await rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMS: TEARDOWN_TIMEOUT_MS })
        } catch (err) {
          h.log(`codex interrupt failed: ${err?.message || err}`)
        }
      }
      await h.syncToDisk()
      // Only flip idle if nothing started meanwhile. A message that arrived
      // during the interrupt or the sync (bounded at 10s) opens a NEW turn,
      // and stamping that idle would let the CP complete the run and tear the
      // VM down under a working agent — nothing would flip it back, because
      // turn/started has already fired. The claude and pi drivers guard the
      // same window.
      if (!finished && abortGen === myGen && !turnActive) h.setState(s, 'idle')
    },

    async setPermissionMode(newMode) {
      if (!SUPPORTED_PERMISSION_MODES.has(newMode)) {
        const e = new Error(`the codex harness supports permission modes 'default' and 'bypassPermissions', not '${newMode}'`)
        e.status = 400
        throw e
      }
      // Codex takes the approval policy per turn ("this turn and subsequent"),
      // so the switch lands on the next turn/start — and the gate above reads
      // `mode` at call time, which covers the in-flight turn.
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
      const turnId = currentTurnId
      turnActive = false
      currentTurnId = null
      // Server shutdown cancels pending permissions before calling us; the
      // interrupt below then has nothing to deadlock on.
      if (turnId) {
        try {
          await rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMS: TEARDOWN_TIMEOUT_MS })
        } catch {
          // best-effort
        }
      }
      chain(finish)
      await serial
    },
  }
}
