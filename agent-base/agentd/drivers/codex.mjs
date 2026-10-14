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
import { pendingWithTimeout } from '../session-control.mjs'
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import zlib from 'node:zlib'
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
import { codexQuestionInput, codexQuestionReply } from './questions.mjs'
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
import { permissionDecisionPayload, contextUsagePayload } from '../event-payloads.mjs'
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
// A compaction is one model call over the whole thread (#1553): generous
// for long threads, bounded so a silent app-server cannot hold the
// session's reservation forever.
const COMPACT_TIMEOUT_MS = 5 * 60_000

const TEARDOWN_TIMEOUT_MS = 10_000

// Reading the old thread and handing its conversation to the new one when a
// thread is rebuilt (#1832). Both are local to the app-server, and both run
// inside session create, which the control plane waits on for 15 s in all
// (agentsession.DaemonClient): bounded well inside that, so a wedged child
// costs the rebuild (a fresh thread), not the session.
const REBUILD_READ_TIMEOUT_MS = 3_000
const REBUILD_INJECT_TIMEOUT_MS = 5_000

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
    // measured against the pinned 0.160.0 with `codex login status`:
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

  let authWriteErr = null
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
    authWriteErr = err
  }

  // No login at all: refuse now, with the fix, rather than start an
  // app-server that can only fail. Without auth.json every turn is rejected
  // by OpenAI (401), which codex reports only as an opaque `systemError`
  // thread status — the user would see "codex reported a system error" and
  // nothing else (#1703). The user's own `codex login` over SSH counts,
  // including one kept in the OS keyring (cli_auth_credentials_store =
  // "keyring" | "auto" in their codex config), which leaves no auth.json.
  if (!(await fileExists(authPath)) && !(await usesCredentialStore(codexHome))) {
    if (authWriteErr && (subscriptionRecord || apiKey)) {
      // The secret IS set; writing the login failed. Say that, not "set it".
      const e = new Error(`could not write the codex login to ${authPath}: ${authWriteErr?.message || authWriteErr}`)
      e.status = authWriteErr?.code === 'ENOSPC' ? 507 : 500
      throw e
    }
    const e = new Error(
      'No OpenAI credential for the codex harness. Set OPENAI_API_KEY (an OpenAI API key) or ' +
      'OPENAI_CODEX_AUTH (the contents of ~/.codex/auth.json after `codex login`) as an organization ' +
      'or agent secret; it reaches the agent when its workspace next boots.',
    )
    e.status = 400
    throw e
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
    // Context usage (#1553): this turn's request size against the model's
    // window, both from the app-server's own accounting (totalTokens already
    // counts the cached input, which is a subset of inputTokens).
    const usage = contextUsagePayload(lastUsage?.totalTokens, lastContextWindow)
    if (usage) s.pusher.emit('context.usage', usage, { turnId: null })
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
    // A question (#1555) is not a tool approval: bypass and run auto-approve
    // must not answer it — an allow without answers is a refusal below.
    if (kind !== 'question') {
      if (mode === 'bypassPermissions') return { allow: true }
      if (spec.auto_approve && !h.isEscalatedTool(toolName, spec.escalate_servers)) {
        return { allow: true }
      }
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
        s.pending.set(requestId, { resolve, toolName, input, ...(kind ? { kind } : {}), ts: Date.now() })
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
        // The platform shape on the way out (#1559), codex's
        // RequestUserInputResponse on the way back.
        const input = codexQuestionInput(params?.questions)
        const d = await gate('request_user_input', input, params?.itemId, codexRequestId, 'question')
        const reply = d.allow ? codexQuestionReply(input, d.updatedInput?.answers) : null
        if (!reply) {
          // Approving without supplying answers is not an answer. Refusing is
          // honest; fabricating would not be.
          throw new Error(d.message || 'no answers were supplied')
        }
        return reply
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
  // Compaction bookkeeping (#1553). The app-server reports one compaction
  // twice: a contextCompaction item (with the counts) and a thread/compacted
  // notification. `compacting` is a manual one in flight (its instructions
  // ride along for the record); whichever signal lands first settles it and
  // `owedSignal` absorbs the other. An automatic compaction is recorded from
  // the item alone (it carries the counts); its notification is ignored. A
  // turn the app-server opens for a compaction is remembered by id so its
  // completion or error is that compaction's, never a phantom result.
  let compacting = null
  let compactInstructions = ''
  let owedSignal = false
  let compactionTurnId = null
  // The model's context window, from thread/tokenUsage/updated (#1553).
  let lastContextWindow = null
  // The pinned app-server's contextCompaction item carries only an id (no
  // counts, checked in codex-cli 0.160.0), so this yields {} today; the
  // names are read defensively for a build that adds them.
  function compactionTokens(source) {
    const pick = (...keys) => {
      for (const key of keys) {
        const v = source?.[key]
        if (Number.isFinite(v)) return v
      }
      return undefined
    }
    const pre = pick('tokensBefore', 'tokens_before', 'activeContextTokensBefore', 'active_context_tokens_before')
    const post = pick('tokensAfter', 'tokens_after', 'activeContextTokensAfter', 'active_context_tokens_after', 'textTokensAfter', 'text_tokens_after')
    return { ...(pre !== undefined ? { pre_tokens: pre } : {}), ...(post !== undefined ? { post_tokens: post } : {}) }
  }
  function onCompacted(tokens, fromItem) {
    if (owedSignal) {
      owedSignal = false
      return
    }
    if (compacting) {
      const waiting = compacting
      compacting = null
      owedSignal = true
      const payload = { trigger: 'manual', ...(compactInstructions ? { instructions: compactInstructions } : {}), ...tokens }
      // Explicit null: a compaction is not a turn (the daemon syncs before
      // answering).
      s.pusher.emit('context.compacted', payload, { turnId: null })
      waiting.resolve(payload)
      return
    }
    if (fromItem) s.pusher.emit('context.compacted', { trigger: 'auto', ...tokens })
  }

  function failCompaction(message) {
    const waiting = compacting
    if (!waiting) return
    compacting = null
    waiting.reject(Object.assign(new Error(message), { status: 502 }))
  }

  function onNotification(method, params) {
    try {
      switch (method) {
        case 'turn/started': {
          const startedId = params?.turn?.id ?? null
          // A compaction may open a turn of its own on the app-server; it
          // is not one this driver armed, and not one to interrupt. Its id
          // is kept so its completion is not read as a real turn's.
          if (compacting && openingTurns.length === 0) {
            compactionTurnId = startedId
            h.log(`codex: turn ${startedId} opened by the compaction; leaving it alone`)
            break
          }
          // A real turn settles whatever a previous compaction left owed.
          owedSignal = false
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
          } else if (item?.type === 'contextCompaction') {
            onCompacted(compactionTokens(item), true)
          } else if (item?.type) {
            // ThreadItem is a growing union (plan, collabAgentToolCall,
            // imageGeneration, …). Dropping a shape this
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
          if (Number.isFinite(params?.tokenUsage?.modelContextWindow)) lastContextWindow = params.tokenUsage.modelContextWindow
          break

        case 'turn/completed': {
          // A completion for a turn that is no longer the live one is stale —
          // an interrupted turn's completion can arrive after the next turn
          // has opened. Acting on it would clear the LIVE turn's state and
          // flip the session idle mid-turn, and the CP reads idle + any
          // recorded result as "run complete" and tears the VM down under a
          // working agent.
          const doneId = params?.turn?.id ?? null
          if (doneId && doneId === compactionTurnId) {
            compactionTurnId = null
            if (params?.turn?.status === 'failed') failCompaction(`codex compaction failed: ${params?.turn?.error?.message ?? 'turn failed'}`)
            break
          }
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
          // A compaction's own failure: reported to the waiting call, not to
          // the timeline as a turn error.
          if (compacting && (!errTurnId || errTurnId === compactionTurnId)) {
            failCompaction(`codex compaction failed: ${params?.error?.message ?? 'error'}`)
            break
          }
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

        case 'thread/compacted':
          if (!params?.threadId || params.threadId === threadId) onCompacted(compactionTokens(params), false)
          break

        case 'thread/status/changed':
          if (params?.status?.type === 'systemError') {
            // Codex gives no reason here. The usual one is OpenAI rejecting
            // the credential (a revoked or wrong key): say so (#1703).
            chain(() => fail(new Error('codex reported a system error; this usually means OpenAI rejected the ' +
              "agent's credential: check its OPENAI_API_KEY or OPENAI_CODEX_AUTH secret")))
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
    const bridge = await connectServers(spec.mcp_servers, h.log, { cwd, env: spec.env })
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
  //
  // Codex freezes the developer instructions too, and that one is a privacy
  // matter (#1832). Measured on the pinned 0.160.0: thread/resume re-sends
  // the developer message rebuilt from the rollout and silently ignores the
  // new developerInstructions (config.developer_instructions, thread/fork and
  // a compaction after resume all fare no better: the compaction even hands
  // the old block to the model while it summarizes). That message carries
  // the member's private memory index and codex's <skills_instructions>
  // listing of the skills seeded then, their private ones included. So a
  // member's private chat that has since been shared would keep running on
  // that member's set-up in front of everyone it is shared with.
  //
  // The control plane says whose set-up a session's instructions are:
  // instructions_scope is "member:<id>" in a member's private workspace and
  // "shared" anywhere else (absent from an older control plane: unknown),
  // followed by what of its owner's own a shared chat brings, e.g.
  // "shared;memories:<id>" (#1836).
  // The record keeps the scope each thread was CREATED (or rebuilt) for,
  // and a thread whose scope is another one is REBUILT, never resumed:
  //   - recorded scope known and different from this session's: rebuild;
  //   - recorded scope unknown (a thread from before this record, or no
  //     record) and this session "shared": rebuild, because that thread may
  //     well be a member's private conversation shared since;
  //   - recorded scope unknown otherwise: resume, as before.
  // Rebuilding keeps the conversation, which is the point of sharing a chat:
  // a NEW thread starts on this session's instructions and tools, and the old
  // thread's model-visible history, minus every developer message and the
  // context codex wrote itself, is injected into it (rebuildThread below).
  // Whatever goes wrong there, the old thread is never resumed: that would
  // hand its instructions straight back to the model.
  const fingerprint = connectorFingerprint(spec.mcp_servers)
  const scope = typeof spec.instructions_scope === 'string' && spec.instructions_scope
    ? spec.instructions_scope
    : undefined
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
  let rebuildFrom = ''
  // The scope of the thread the session ends up on: this session's for a
  // thread it creates or rebuilds, the recorded one for a thread it resumes.
  let threadScope = scope
  if (resumeHandle) {
    const records = await readRecords()
    const recorded = threadRecord(records[resumeHandle])
    if (recorded?.tools !== undefined && recorded.tools !== fingerprint) {
      h.log(`codex: connectors changed since thread ${resumeHandle} was created ` +
        `(was "${recorded.tools}", now "${fingerprint}"); starting a fresh thread`)
      resumeHandle = ''
    } else if (recorded?.scope !== undefined ? recorded.scope !== scope : isSharedScope(scope)) {
      h.log(`codex: thread ${resumeHandle} was created for instructions scope ` +
        `"${recorded?.scope ?? 'unknown'}", this session's is "${scope ?? 'unknown'}"; rebuilding it without its old instructions`)
      rebuildFrom = resumeHandle
      resumeHandle = ''
    } else {
      threadScope = recorded?.scope
    }
  }

  // dynamicTools is a thread/START-only parameter; passing it to thread/resume
  // is silently ignored (unknown params are), which would look like it worked.
  const startParams = () => (toolSpecs.length > 0 ? { ...threadParams, dynamicTools: toolSpecs } : threadParams)

  // Rebuild (#1832): a new thread on this session's instructions and tools,
  // carrying the old thread's conversation. The history is reconstructed from
  // the old rollout the way codex itself would resume it (codexRolloutHistory
  // below), then injected with the experimental thread/inject_items, which
  // records raw items into the new thread's history right after the initial
  // context thread/start wrote: the new developer message, the old turns,
  // then the next message. Measured on the pinned 0.160.0.
  //
  // Any failure to read the old conversation starts a plain fresh thread,
  // which loses the model's context but never its privacy. Only thread/start
  // failing throws, into the same 502 as any fresh start.
  async function rebuildThread(oldThreadId) {
    let items
    try {
      const path = await locateRollout(oldThreadId)
      items = codexRolloutHistory(await readCodexRolloutLineage(codexHome, path), oldThreadId)
    } catch (err) {
      h.log(`codex: could not read thread ${oldThreadId} to rebuild it (${err?.message || err}); ` +
        'starting a fresh thread without its conversation')
      return await rpc.request('thread/start', startParams())
    }
    const fresh = await rpc.request('thread/start', startParams())
    const newThreadId = fresh?.thread?.id
    if (!newThreadId || items.length === 0) {
      h.log(`codex: thread ${oldThreadId} had no conversation to carry over; started a fresh thread`)
      return fresh
    }
    try {
      await rpc.request('thread/inject_items', { threadId: newThreadId, items }, { timeoutMS: REBUILD_INJECT_TIMEOUT_MS })
      h.log(`codex: rebuilt thread ${oldThreadId} as ${newThreadId} for instructions scope "${scope ?? 'unknown'}": ` +
        `${items.length} conversation items carried over, its old instructions left behind`)
    } catch (err) {
      // A refusal leaves the new thread as fresh as thread/start made it:
      // the app-server validates every item before recording any. A timeout
      // may still land, ahead of the first turn (inject and turn/start are
      // serialized per thread). Either way what we sent is filtered, so no
      // old instructions arrive.
      h.log(`codex: injecting the conversation of ${oldThreadId} into ${newThreadId} failed ` +
        `(${err?.message || err}); continuing on the new thread, which may lack it`)
    }
    return fresh
  }

  // The old thread's CURRENT rollout, as the app-server resolves it
  // (thread.path, marked [UNSTABLE] in 0.160.0). A paginated thread that was
  // reverted has several rollout files, and only the app-server's state
  // database knows which one is current, so the search under sessions/ that
  // stands in when thread/read fails accepts a single candidate only.
  async function locateRollout(threadId) {
    let path = ''
    try {
      const read = await rpc.request('thread/read', { threadId }, { timeoutMS: REBUILD_READ_TIMEOUT_MS })
      path = typeof read?.thread?.path === 'string' ? read.thread.path : ''
    } catch (err) {
      h.log(`codex: thread/read ${threadId} failed (${err?.message || err}); searching ${codexHome} for its rollout`)
    }
    // Cold-rollout compression (off by default in 0.160.0) may have turned
    // the file the app-server names into a .jsonl.zst.
    for (const candidate of path ? [path, `${path}.zst`] : []) {
      if (await fileExists(candidate)) return candidate
    }
    const found = await findRollouts(codexHome, (name) =>
      rolloutNameIds(name)?.threadId === threadId)
    if (found.length === 1) return found[0]
    throw new Error(found.length === 0
      ? `no rollout for thread ${threadId}`
      : `thread ${threadId} has ${found.length} rollout files and the app-server did not say which is current`)
  }

  let started
  try {
    if (rebuildFrom) {
      started = await rebuildThread(rebuildFrom)
    } else if (resumeHandle) {
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
        threadScope = scope
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
  // Record this thread's connector set and instructions scope so a later
  // session can judge THIS thread rather than whichever one happened to be
  // created last. Bounded: workspaces are long-lived and a thread per session
  // would grow unbounded. A resumed thread keeps the scope it was created
  // for, unknown included: this session's scope says nothing about the
  // instructions an older thread carries.
  try {
    const records = await readRecords()
    // Re-inserted, so the bound below evicts the thread used least recently,
    // not the one recorded first.
    delete records[threadId]
    records[threadId] = { tools: fingerprint, ...(threadScope !== undefined ? { scope: threadScope } : {}) }
    const keys = Object.keys(records)
    const MAX_RECORDS = 50
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_RECORDS))) delete records[stale]
    await writeFile(fingerprintPath, JSON.stringify(records) + '\n', { mode: 0o600 })
  } catch (err) {
    // A missing record reads as "unknown": the thread resumes, unless the
    // next session is a shared one, which rebuilds it (see above).
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

    // Persistent model switch (#1552): model and effort ride every turn/start
    // from the spec, so the switch is a spec mutation that lands on the next
    // turn. A message delivered by turn/steer carries neither; the daemon
    // only calls this between turns, so the next message opens a turn/start.
    // Effort is clamped per model control-plane side (ClampCodexEffort); the
    // app-server validates nothing locally.
    async setModel({ model, effort }) {
      if (model) {
        spec.model = model
        currentModel = model
      }
      if (effort) spec.effort = effort
    },

    // Manual compaction (#1553): the app-server's thread/compact/start.
    // Codex takes no custom instructions; they are recorded on the event
    // but not sent. Completion is the thread/compacted notification (or the
    // contextCompaction item), bounded by a timeout.
    async compact({ instructions } = {}) {
      if (compacting) throw Object.assign(new Error('a compaction is already in flight'), { status: 409 })
      const slot = pendingWithTimeout(COMPACT_TIMEOUT_MS, 'compaction timed out')
      compacting = slot
      compactInstructions = instructions || ''
      compactionTurnId = null
      // A new compaction settles any signal still owed from the last one.
      owedSignal = false
      try {
        await rpc.request('thread/compact/start', { threadId })
      } catch (err) {
        compacting = null
        slot.reject(err)
        throw Object.assign(new Error(`codex compaction failed: ${err?.message || err}`), { status: 502 })
      }
      return await slot.promise.finally(() => { if (compacting === slot) compacting = null })
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

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// usesCredentialStore reports a codex config that keeps logins in the OS
// keyring rather than auth.json (cli_auth_credentials_store "keyring" or
// "auto"). Unreadable or absent config means the default file store.
async function usesCredentialStore(codexHome) {
  try {
    const cfg = await readFile(`${codexHome}/config.toml`, 'utf8')
    return /^\s*cli_auth_credentials_store\s*=\s*["'](keyring|auto)["']/m.test(cfg)
  } catch {
    return false
  }
}

// isSharedScope reports an instructions_scope for a shared chat or a run:
// "shared", with or without what of its owner's own it brings (#1836).
function isSharedScope(scope) {
  return scope === 'shared' || (typeof scope === 'string' && scope.startsWith('shared;'))
}

// threadRecord reads one entry of .zwrm-thread-tools.json: {tools, scope}
// since #1832, a bare connector fingerprint before it (scope unknown).
// Anything else reads as no record at all.
function threadRecord(value) {
  if (typeof value === 'string') return { tools: value, scope: undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return {
    tools: typeof value.tools === 'string' ? value.tools : undefined,
    scope: typeof value.scope === 'string' && value.scope ? value.scope : undefined,
  }
}

async function readRolloutBytes(path) {
  const raw = await readFile(path)
  if (!path.endsWith('.zst')) return raw
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(`this node cannot read the compressed rollout ${path}`)
  }
  return zlib.zstdDecompressSync(raw)
}

// rolloutNameIds parses a rollout file name (rollout/src/rollout_file_name.rs):
// rollout-<timestamp>-<thread id>.jsonl, or for a reverted thread's newer
// rollout, rollout-<timestamp>-<thread id>_<rollout id>.jsonl; .zst when
// compressed. A plain rollout's id is its thread's.
function rolloutNameIds(name) {
  const m = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([^_/]+?)(?:_([^_/]+))?\.jsonl(?:\.zst)?$/.exec(name)
  return m ? { threadId: m[1], rolloutId: m[2] ?? m[1] } : null
}

// Rollout files under codex's sessions and archived_sessions directories
// whose file name satisfies match.
async function findRollouts(codexHome, match) {
  const found = []
  for (const dir of [`${codexHome}/sessions`, `${codexHome}/archived_sessions`]) {
    let entries = []
    try {
      entries = await readdir(dir, { recursive: true })
    } catch { /* no such directory: nothing in it */ }
    for (const entry of entries) {
      if (match(String(entry).split('/').pop())) found.push(`${dir}/${entry}`)
    }
  }
  return found
}

// readCodexRolloutLineage returns a thread's rollout as codex replays it,
// oldest segment first. A paginated thread that was reverted (thread/revert)
// or forked by reference continues an immutable prefix of another rollout:
// its session_meta.history_base names that rollout and the byte offset its
// prefix ends at, and that prefix may continue another in turn
// (thread-store/src/local/rollout_lineage.rs).
export async function readCodexRolloutLineage(codexHome, path) {
  const segments = []
  const seen = new Set()
  let text = (await readRolloutBytes(path)).toString('utf8')
  for (;;) {
    segments.unshift(text)
    const base = rolloutSessionMeta(text)?.history_base
    if (!base) return segments
    const rolloutId = base.thread_id
    if (typeof rolloutId !== 'string' || seen.has(rolloutId) || seen.size >= 64) {
      throw new Error('the rollout lineage is malformed (a cycle, or deeper than 64)')
    }
    seen.add(rolloutId)
    const found = await findRollouts(codexHome, (name) => rolloutNameIds(name)?.rolloutId === rolloutId)
    if (found.length !== 1) throw new Error(`cannot find the single rollout ${rolloutId} the history continues`)
    const bytes = await readRolloutBytes(found[0])
    const end = Number(base.end_byte_offset)
    if (!Number.isSafeInteger(end) || end < 0 || end > bytes.length) {
      throw new Error(`rollout ${rolloutId} is shorter than the history that continues it`)
    }
    text = bytes.subarray(0, end).toString('utf8')
  }
}

// The first session_meta of a rollout; codex writes it as the first line,
// so the scan stops there rather than parsing the whole file.
function rolloutSessionMeta(text) {
  for (const line of String(text).split('\n')) {
    const [record] = parseRolloutLines(line)
    if (record?.type === 'session_meta') return record.payload
  }
  return undefined
}

// Rollout records; codex skips an unreadable line too (a write torn by a
// crash), and a compacted line it cannot decode.
function parseRolloutLines(text) {
  const records = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!record || typeof record !== 'object' || typeof record.type !== 'string') continue
    if (record.type === 'compacted' && !compactedLineReadable(record.payload)) continue
    records.push(record)
  }
  return records
}

// ---- rollout reconstruction (#1832) -----------------------------------------
//
// codexRolloutHistory rebuilds a thread's model-visible history from its
// rollout the way the pinned codex 0.160.0 does when it resumes the thread
// (core/src/session/rollout_reconstruction.rs), and returns what a REBUILT
// thread may carry of it: the conversation, without the instructions it ran
// on. What codex does, mirrored:
//   - response_item lines append to the history. Codex drops system messages
//     and item types it does not know, and reads a code-mode "delivered
//     assistant message" back as retained context, not history.
//   - a compacted line's replacement_history REPLACES the history. The newest
//     compaction bounds the replay when it carries window_number and
//     resume_metadata (or the thread's history_mode is "paginated", as
//     0.160.0 writes it); otherwise the newest compaction that no rollback
//     undid does, found by replaying turn segments backwards.
//   - thread_rolled_back drops the newest N user turns.
//   - a paginated thread reverted (thread/revert) or forked by reference
//     replays the prefix of the rollout it continues first
//     (readCodexRolloutLineage hands those in as earlier segments).
// What a rebuilt thread does NOT carry:
//   - any developer-role item: the old developerInstructions with a member's
//     memory index, codex's own permissions text and <skills_instructions>
//     listing (private skills included), AGENTS.md, tool declarations. A
//     mid-turn compaction writes that developer message into its
//     replacement_history too, so it goes from there as well.
//   - the user-role context codex writes itself (contextual_user_message.rs):
//     <environment_context>, a selected skill's SKILL.md body, AGENTS.md,
//     hook prompts and the like. The new thread writes its own.
//   - anything encrypted (reasoning, an encrypted compaction, encrypted tool
//     arguments and output) and item ids: see plainItem. A remote
//     compaction's older turns come back as the plain messages it retained
//     (checkpointHistory).
// Kept in order: user and assistant messages, every tool call with its
// output, a local compaction's summary. Codex pairs calls with outputs again
// when it builds a request, as on any resume.
//
// Throws on what it cannot rebuild faithfully (no session_meta, another
// thread's rollout, an unknown history mode, a legacy compaction without
// replacement_history, multi-agent messages); the caller then starts fresh.
export function codexRolloutHistory(rollout, threadId) {
  // One rollout's text, or a lineage from readCodexRolloutLineage: oldest
  // segment first, the thread's own rollout last.
  const segments = Array.isArray(rollout) ? rollout : [rollout]
  const own = parseRolloutLines(segments.at(-1) ?? '')
  const meta = own.find((r) => r.type === 'session_meta')?.payload
  if (!meta || typeof meta !== 'object') throw new Error('not a codex rollout (no session_meta)')
  if (threadId && meta.id !== threadId) throw new Error(`the rollout is thread ${meta.id}'s, not ${threadId}'s`)
  const historyMode = meta.history_mode ?? 'legacy'
  if (historyMode !== 'legacy' && historyMode !== 'paginated') {
    throw new Error(`unknown codex history mode "${historyMode}"`)
  }
  if (segments.length > 1 && historyMode !== 'paginated') throw new Error('a history base on a thread that is not paginated')
  // Each segment's session_meta stays in place: reconstruction reads none.
  const records = [...segments.slice(0, -1).flatMap(parseRolloutLines), ...own]

  const checkpoint = replayCheckpoint(records, historyMode)
  let history = checkpoint < 0 ? [] : checkpointHistory(records[checkpoint].payload)
  for (const { type, payload, metadata } of records.slice(checkpoint + 1)) {
    if (type === 'response_item') {
      if (isHistoryItem(payload, metadata) && !isDeliveredAssistantMessage(payload, metadata)) {
        history.push({ item: payload, metadata })
      }
    } else if (type === 'compacted') {
      // One past the chosen compaction sits inside a rolled-back turn; codex
      // keeps that turn's original items so the rollback can find it. Only
      // a compaction from before replacement_history existed rewrites the
      // history here, and no codex this platform has pinned writes one.
      if (!Array.isArray(payload.replacement_history)) {
        throw new Error('a legacy compaction without replacement_history')
      }
    } else if (type === 'event_msg' && payload?.type === 'thread_rolled_back') {
      history = dropLastUserTurns(history, payload.num_turns)
    } else if (type === 'inter_agent_communication') {
      throw new Error('multi-agent messages, which this driver never starts')
    }
  }
  return history.flatMap((e) => plainItem(e.item))
}

// Codex's SUMMARY_PREFIX (prompts/templates/compact/summary_prefix.md): a
// local compaction records its summary as a user message beginning with it.
const CODEX_SUMMARY_PREFIX = 'Another language model started to solve this problem and produced a summary ' +
  'of its thinking process. You also have access to the state of the tools that were used by that language ' +
  'model. Use this to build on the work that has already been done and avoid duplicating work. Here is the ' +
  'summary produced by the other language model, use the information in this summary to assist with your ' +
  'own analysis:'

// The ResponseItem variants codex 0.160.0 keeps in history (protocol
// models.rs, context_manager/history.rs is_api_message). Any other type
// deserializes as `Other`, which codex drops.
const HISTORY_ITEM_TYPES = new Set([
  'message', 'agent_message', 'reasoning', 'local_shell_call', 'function_call', 'function_call_output',
  'tool_search_call', 'tool_search_output', 'custom_tool_call', 'custom_tool_call_output', 'web_search_call',
  'image_generation_call', 'compaction', 'compaction_summary', 'context_compaction', 'additional_tools',
])

// The marked user-role fragments codex writes itself
// (context/contextual_user_message.rs CONTEXTUAL_USER_FRAGMENT_MATCHERS);
// isCodexContextualUserText adds the ones matched by other rules.
const CONTEXTUAL_USER_MARKERS = [
  ['# AGENTS.md instructions', '</INSTRUCTIONS>'],
  ['<environment_context>', '</environment_context>'],
  ['<agent_message_board_notification>', '</agent_message_board_notification>'],
  ['<skill>', '</skill>'],
  ['<user_shell_command>', '</user_shell_command>'],
  ['<turn_aborted>', '</turn_aborted>'],
  ['<subagent_notification>', '</subagent_notification>'],
  ['<recommended_plugins>', '</recommended_plugins>'],
]

// isCodexContextualUserText reports one input_text of a user message that
// codex generated rather than the user wrote. A message with any such part
// is context as a whole, as codex reads it.
export function isCodexContextualUserText(text) {
  if (typeof text !== 'string') return false
  const t = text.trim()
  // A hook's prompt (protocol items.rs parse_hook_prompt_fragment).
  if (/^<hook_prompt\b[^>]*\bhook_run_id="[^"]*\S[^"]*"[^>]*>[\s\S]*<\/hook_prompt>$/.test(t)) return true
  if (CONTEXTUAL_USER_MARKERS.some(([start, end]) => markedText(start, end, text))) return true
  // <external_KEY>…</external_KEY> (AdditionalContextUserFragment).
  const external = /^<external_([^>]*)>/.exec(t)
  if (external && t.endsWith(`</external_${external[1]}>`)) return true
  // InternalModelContextFragment, and the goal context it replaced.
  if (t.startsWith('<goal_context>') && t.endsWith('</goal_context>')) return true
  if (/^<codex_internal_context source="[a-z][a-z0-9_]*">/.test(t) && t.endsWith('</codex_internal_context>')) return true
  // Warnings older codex versions recorded as user messages.
  if (t.startsWith('Warning: apply_patch was requested via ') &&
    t.endsWith('Use the apply_patch tool instead of exec_command.')) return true
  return t.startsWith('Warning: Your account was flagged for potentially high-risk cyber activity') ||
    t.startsWith('Warning: The maximum number of unified exec processes you can keep open is')
}

// fragment.rs matches_marked_text: both markers, ASCII case-insensitive,
// around the text with its outer whitespace trimmed.
function markedText(start, end, text) {
  const head = text.trimStart()
  const whole = head.trimEnd()
  return head.slice(0, start.length).toLowerCase() === start.toLowerCase() &&
    whole.length >= end.length && whole.slice(whole.length - end.length).toLowerCase() === end.toLowerCase()
}

function isContextualUserContent(content) {
  return Array.isArray(content) && content.some((c) => c?.type === 'input_text' && isCodexContextualUserText(c.text))
}

// A compacted line codex can decode: replacement_history_metadata, when
// present, pairs one-to-one with replacement_history (rollout_payload.rs).
function compactedLineReadable(payload) {
  if (!payload || typeof payload !== 'object') return false
  const meta = payload.replacement_history_metadata
  if (meta == null) return true
  return Array.isArray(meta) && Array.isArray(payload.replacement_history) &&
    meta.length === payload.replacement_history.length
}

// The history a compaction leaves, as a rebuilt thread may carry it. A
// local compaction's replacement_history is plain text: the user messages
// and a summary. A remote one (OpenAI's own provider, which production
// uses) keeps the user messages whole and replaces everything else before
// it with an encrypted compaction item: the server's encoding of that
// window, the old developer message included. That item stays behind
// (plainItem). Its retained_context keeps the assistant replies as plain
// text, at most 8 of them and each cut to about 900 tokens, so those come
// back, interleaved with the user messages by the order both carry
// (user_input_order on a kept message, order on a retained one). The older
// turns' tool calls are not kept.
function checkpointHistory(compacted) {
  const replaced = replacementHistory(compacted)
  if (!replaced.some((e) => isEncryptedCompaction(e.item))) return replaced
  const kept = replaced.filter((e) => !isEncryptedCompaction(e.item))
  const retained = compacted.retained_context
  const replies = retainedMessages(retained?.assistant_messages, 'assistant')
  if (replies.length === 0) return kept
  const userOrder = (e) => acceptanceOrder(e.metadata)
  const isUser = (e) => e.item?.type === 'message' && e.item.role === 'user' && !isContextualUserContent(e.item.content)
  if (kept.some((e) => isUser(e) && userOrder(e) == null)) {
    // Nothing to interleave by: the plain messages retained_context kept,
    // users and replies in their own order.
    return [...retainedMessages(retained?.user_messages, 'user'), ...replies]
      .sort((a, b) => a.order - b.order || (a.item.role === 'user' ? -1 : 1))
  }
  const out = []
  let r = 0
  for (const e of kept) {
    const order = isUser(e) ? userOrder(e) : null
    while (order != null && r < replies.length && replies[r].order < order) out.push(replies[r++])
    out.push(e)
  }
  return [...out, ...replies.slice(r)]
}

// retainedMessages turns retained_context entries into plain messages, in
// their order; an inherited entry (a forked thread's) or one without text or
// order is left out.
function retainedMessages(list, role) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => typeof m?.text === 'string' && m.text !== '' && Number.isFinite(m.order) && !m.inherited)
    .sort((a, b) => a.order - b.order)
    .map((m) => ({
      order: m.order,
      item: {
        type: 'message',
        role,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: m.text }],
        ...(role === 'assistant' && typeof m.phase === 'string' && m.phase ? { phase: m.phase } : {}),
      },
      metadata: undefined,
    }))
}

function isEncryptedCompaction(item) {
  return item?.type === 'compaction' || item?.type === 'compaction_summary' || item?.type === 'context_compaction'
}

function replacementHistory(compacted) {
  const meta = Array.isArray(compacted.replacement_history_metadata) ? compacted.replacement_history_metadata : []
  return compacted.replacement_history.map((item, i) => ({ item, metadata: meta[i] ?? undefined }))
}

// The compaction whose replacement_history the replay starts from, or -1
// (rollout_reconstruction.rs select_input_compaction and the reverse scan
// after it).
function replayCheckpoint(records, historyMode) {
  let newest = -1
  for (let i = records.length - 1; i >= 0 && newest < 0; i--) {
    if (records[i].type === 'compacted') newest = i
  }
  if (newest < 0) return -1
  const c = records[newest].payload
  if (Array.isArray(c.replacement_history) && c.window_number != null &&
    (c.resume_metadata != null || historyMode === 'paginated')) {
    return newest
  }
  // Otherwise: the newest compaction no rollback undid. Read backwards, the
  // rollout falls into turn segments, each closed by its task_started, and
  // a rollback of N skips the next N segments that hold a user turn, along
  // with any compaction inside them.
  let rollbackTurns = 0
  let found = -1
  let segment = null
  const open = () => (segment ??= { turnId: null, userTurn: false, checkpoint: -1 })
  const close = () => {
    const done = segment
    segment = null
    if (rollbackTurns > 0) {
      if (done.userTurn) rollbackTurns--
      return
    }
    if (found < 0 && done.checkpoint >= 0) found = done.checkpoint
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const { type, payload, metadata } = records[i]
    if (type === 'compacted') {
      open()
      if (segment.checkpoint < 0 && Array.isArray(payload.replacement_history)) segment.checkpoint = i
    } else if (type === 'turn_context') {
      open()
      if (segment.turnId == null) segment.turnId = payload?.turn_id ?? null
    } else if (type === 'world_state') {
      open()
    } else if (type === 'response_item') {
      if (isDeliveredAssistantMessage(payload, metadata)) continue
      if (isUserTurnBoundary(payload)) open().userTurn = true
      else open()
    } else if (type === 'inter_agent_communication') {
      open().userTurn = true
    } else if (type === 'event_msg') {
      const turnId = payload?.turn_id ?? null
      switch (payload?.type) {
        case 'thread_rolled_back':
          rollbackTurns += Math.max(0, Number(payload.num_turns) || 0)
          break
        case 'task_complete':
        case 'turn_complete':
          open()
          if (segment.turnId == null) segment.turnId = turnId
          break
        case 'turn_aborted':
          if (segment) {
            if (segment.turnId == null) segment.turnId = turnId
          } else if (turnId != null) {
            segment = { turnId, userTurn: false, checkpoint: -1 }
          }
          break
        case 'user_message':
          open().userTurn = true
          break
        case 'task_started':
        case 'turn_started':
          if (segment && (segment.turnId == null || turnId == null || segment.turnId === turnId)) close()
          break
      }
    }
  }
  if (segment) close()
  return found
}

// ContextManager::drop_last_n_user_turns. Its trimming of the context codex
// wrote just above the cut is left out: plainItem drops all of it anyway.
function dropLastUserTurns(history, n) {
  const turns = Math.max(0, Number(n) || 0)
  if (turns === 0) return history
  const positions = []
  history.forEach((e, i) => { if (isUserTurnBoundary(e.item)) positions.push(i) })
  if (positions.length === 0) return history
  const cut = turns >= positions.length ? positions[0] : positions[positions.length - turns]
  // Replies and calls accepted after the first removed turn's input go with
  // it, even where they were recorded before it.
  const boundary = acceptanceOrder(history[cut].metadata)
  return history.slice(0, cut).filter((e) => {
    if (boundary == null) return true
    const reply = (e.item?.type === 'message' && e.item.role === 'assistant') || e.item?.type === 'function_call'
    const order = acceptanceOrder(e.metadata)
    return !(reply && order != null && order >= boundary)
  })
}

function acceptanceOrder(metadata) {
  if (metadata?.inherited_user_message) return null
  return Number.isFinite(metadata?.user_input_order) ? metadata.user_input_order : null
}

// context_manager/history.rs is_user_turn_boundary.
function isUserTurnBoundary(item) {
  if (item?.type === 'agent_message') return true
  if (item?.type !== 'message') return false
  const content = Array.isArray(item.content) ? item.content : []
  if (item.role === 'user') {
    return !isContextualUserContent(content) && !content.some((c) =>
      c?.type === 'input_text' && typeof c.text === 'string' && c.text.startsWith(`${CODEX_SUMMARY_PREFIX}\n`))
  }
  return item.role === 'assistant' && isInterAgentContent(content)
}

// InterAgentCommunication::from_message_content: one text part holding the
// serialized message.
function isInterAgentContent(content) {
  if (content.length !== 1) return false
  const c = content[0]
  if ((c?.type !== 'input_text' && c?.type !== 'output_text') || typeof c.text !== 'string') return false
  try {
    const v = JSON.parse(c.text)
    return Boolean(v) && typeof v === 'object' && typeof v.author === 'string' &&
      typeof v.recipient === 'string' && typeof v.content === 'string' && typeof v.trigger_turn === 'boolean'
  } catch {
    return false
  }
}

function isHistoryItem(item, metadata) {
  if (!item || typeof item !== 'object') return false
  if (item.type === 'message') return item.role !== 'system'
  if (item.type === 'configuration_update') return Boolean(metadata?.harness_authored_configuration)
  return HISTORY_ITEM_TYPES.has(item.type)
}

// A code-mode "delivered assistant message": written as a response_item,
// read back by codex as retained context rather than history
// (history/src/rollout_payload.rs).
function isDeliveredAssistantMessage(item, metadata) {
  const marker = metadata?.delivered_assistant_message
  return typeof marker === 'string' && metadata.user_input_order != null &&
    (marker === 'codex:code-mode-delivery:v1:complete' || marker.startsWith('codex:code-mode-delivery:v1:incomplete:')) &&
    item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content) &&
    item.content.length === 1 && item.content[0]?.type === 'output_text' &&
    item.internal_chat_message_metadata_passthrough?.turn_id != null
}

// plainItem is what a rebuilt thread carries of one history item: plain
// conversation only, as a list of zero or one items.
//   - Not the old instructions: no developer or system item, and none of the
//     user-role context codex wrote itself.
//   - Nothing encrypted. A reasoning item, an encrypted compaction and
//     encrypted tool arguments or output are opaque to us, may encode the
//     old instructions (a remote compaction does), and are bound to the
//     account that made them: a thread rebuilt on another credential (a
//     member's own key in their private chat, the org's once it's shared)
//     would have every request refused for them.
//   - No item ids: they name the old account's server-side items.
// A reasoning-effort control (configuration_update) goes too: codex keeps
// one only with its own provenance, so injected it would be dropped anyway.
const WITHHELD_OUTPUT = '[This output was encrypted for another session and is not carried over.]'

function plainItem(item) {
  if (!item || typeof item !== 'object') return []
  if (item.role === 'developer' || item.role === 'system') return []
  if (item.type === 'message' && item.role === 'user' && isContextualUserContent(item.content)) return []
  if (item.type === 'reasoning' || item.type === 'configuration_update' || item.type === 'agent_message' ||
    isEncryptedCompaction(item)) return []
  const { id: _id, encrypted_function_args: _args, ...plain } = item
  if (Array.isArray(plain.content)) plain.content = plain.content.filter((c) => c?.type !== 'encrypted_content')
  if (Array.isArray(plain.output)) {
    const parts = plain.output.filter((c) => c?.type !== 'encrypted_content')
    // A call's output that was all encrypted still answers the call, and
    // says so, rather than reading as an empty result.
    plain.output = parts.length === 0 && plain.output.length > 0 ? WITHHELD_OUTPUT : parts
  }
  return [plain]
}
