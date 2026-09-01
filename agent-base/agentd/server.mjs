// zwrm-agentd — in-VM session daemon for interactive coding-agent sessions (#709).
//
// Hosts ONE harness session at a time behind a bearer-authenticated HTTP+JSON
// API on the VM's TAP IP (mesh-reachable by the control plane), and pushes
// the session's event stream to a control-plane callback URL. Launched at
// boot by the VM init (as the non-root agent user) when the agent boot config
// carries a session_daemon spec. See designs/AGENT_SESSIONS.md.
//
// The harness-specific half of a session lives in drivers/ (#1063): the
// claude driver wraps the Claude Agent SDK, the pi driver embeds the pi
// coding-agent SDK, and the codex driver speaks JSON-RPC to `codex app-server`
// (#1088). This file owns everything harness-neutral — HTTP surface, auth,
// event pusher, permission/park bookkeeping, files/skills APIs, lifecycle.
//
// Event contract:
//  - every event gets a session-monotonic seq from a single counter, so
//    ordering is total across durable and ephemeral events;
//  - `ephemeral: true` marks token-stream partials (sdk.partial) the control
//    plane fans out live but does not persist — replay needs only durable
//    events, since the complete sdk.assistant message supersedes its partials;
//  - pushes are batched, single-in-flight, in-order, retried with backoff,
//    and idempotent for the receiver (dedup on (session_id, seq)).

import { createServer } from 'node:http'
import { readFileSync, createReadStream, createWriteStream } from 'node:fs'
import { lstat, readdir, mkdir, realpath, rename, unlink, rm, writeFile, readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform, Readable } from 'node:stream'
import { resolve as pathResolve, dirname } from 'node:path'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DRIVERS, HARNESSES, HARNESS_CAPS, unsupportedPermissionMode } from './drivers/registry.mjs'
import { TOOL_POLICIES } from './drivers/tool-policy.mjs'
import { countBackgroundTasks } from './drivers/claude-tasks.mjs'
import { seedState, waitSeedClear, SEED_WAIT_MAX_MS, SEED_FAILED_MESSAGE } from './seedgate.mjs'
import { TurnEventContext } from './turn-events.mjs'
import { permissionDecisionPayload } from './event-payloads.mjs'
import { ChangedFileTracker } from './changed-files.mjs'
import { prepareMessage } from './message-context.mjs'
import { searchWorkspaceFiles } from './file-search.mjs'
import {
  executeShellCommand,
  MAX_SHELL_OUTPUT_BYTES,
  normalizeCommandName,
  shellContext,
  supportsCommandDriver,
} from './session-control.mjs'

const DEFAULT_PORT = 9924
const MAX_BODY_BYTES = 1024 * 1024
// One in-flight batch keeps ordering; the short flush window coalesces token
// partials without adding visible latency.
const FLUSH_MS = 150
const MAX_BATCH = 200
const MAX_RETRY_MS = 30_000
// Beyond this queue depth (control plane unreachable), ephemeral partials are
// dropped oldest-first; durable events are never dropped — they are what
// replay is built from.
const MAX_QUEUE = 50_000

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions'])

// The harnesses this daemon build can host live in drivers/registry.mjs
// (imported above): one table drives the accepted spec.harness values, the
// /healthz harness caps, the construct dispatch, and per-harness permission
// modes, so they cannot drift apart again (#1160).

// Platform sleep cap (#803): a sleeping run holds its workspace slot, a
// memory-sized snapshot, and a reserved IP — hours are fine, days are not.
// Longer waits belong to ending the turn with a handoff + a follow-up run
// (see the tool descriptions and the run preamble).
const MAX_SLEEP_SECONDS = 6 * 3600

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

// syncToDisk durably flushes the guest page cache before a terminal event is
// pushed: the control plane tears the VM down as soon as it observes
// sdk.result / session.ended, and a teardown that misses the guest's graceful
// window force-kills Firecracker with every dirty page — including the SDK
// transcript tail that keyed-workspace resume depends on. A truncated
// transcript resumes as a half-done task and the next run repeats it (#888).
// sync(1) is guest-wide, but the VM is small and the write is what we're
// here for; bounded so a wedged disk can't stall event delivery.
function syncToDisk() {
  return new Promise((resolve) => {
    // Belt: execFile's timeout TERMs a merely-slow child so stragglers get
    // reaped. Braces: the outer timer resolves even when the child is stuck
    // in D-state and cannot die — event delivery must never wedge on a disk.
    const timer = setTimeout(() => {
      log('syncToDisk: sync still running after 10s; proceeding without it')
      resolve()
    }, 10_000)
    execFile('sync', { timeout: 10_000 }, (err) => {
      clearTimeout(timer)
      if (err) log(`syncToDisk: sync failed: ${err?.message || err}`)
      resolve()
    })
  })
}

// ---- config -----------------------------------------------------------------

const cfgPath = process.env.ZWRM_AGENTD_CONFIG
if (!cfgPath) {
  console.error('ZWRM_AGENTD_CONFIG is not set')
  process.exit(1)
}
let config
try {
  config = JSON.parse(readFileSync(cfgPath, 'utf8'))
} catch (err) {
  console.error(`failed to read daemon config ${cfgPath}: ${err.message}`)
  process.exit(1)
}
if (typeof config.token !== 'string' || config.token === '') {
  console.error(`daemon config ${cfgPath} has no token`)
  process.exit(1)
}
const PORT = Number(config.port) || DEFAULT_PORT

// Hash both sides so the comparison is constant-time regardless of length.
const tokenDigest = createHash('sha256').update(config.token).digest()
function tokenMatches(presented) {
  if (typeof presented !== 'string' || presented === '') return false
  return timingSafeEqual(createHash('sha256').update(presented).digest(), tokenDigest)
}

// ---- event pusher ---------------------------------------------------------------

class EventPusher {
  constructor(url, token, sessionId) {
    this.url = url
    this.token = token
    this.sessionId = sessionId
    this.queue = []
    this.seq = 0
    this.timer = null
    this.inFlight = false
    this.retryMs = 1000
    this.stopped = false
    this.turns = new TurnEventContext()
    this.changedFiles = new ChangedFileTracker()
  }

  beginTurn(harness) {
    const wasDraining = this.turns.drainingTurnId !== null
    const started = this.turns.begin(harness)
    if (started && !wasDraining) this.changedFiles.reset()
    if (started) this.emit('turn.started', started.payload, { turnId: started.turnId })
    return this.turns.activeTurnId
  }

  completeTurn(status = 'completed') {
    const completed = this.turns.complete(status)
    if (completed) this.emit('turn.completed', completed.payload, { turnId: completed.turnId })
    return completed?.turnId ?? null
  }

  rotateTurn(harness, status = 'completed') {
    const { completed, started } = this.turns.rotate(harness, status)
    if (completed) this.emit('turn.completed', completed.payload, { turnId: completed.turnId })
    this.changedFiles.reset()
    if (started) this.emit('turn.started', started.payload, { turnId: started.turnId })
    return started?.turnId ?? null
  }

  startDrainingTurn(status = 'interrupted') {
    const completed = this.turns.startDraining(status)
    if (completed) this.emit('turn.completed', completed.payload, { turnId: completed.turnId })
    return completed?.turnId ?? null
  }

  finishDrainingTurn(turnId) {
    this.turns.finishDraining(turnId)
    this.changedFiles.reset()
  }

  isTurnDraining() {
    return this.turns.drainingTurnId !== null
  }

  emit(type, payload, options = {}) {
    const ephemeral = options.ephemeral ?? false
    let turnId = Object.prototype.hasOwnProperty.call(options, 'turnId')
      ? options.turnId
      : this.turns.implicitEventTurnId(type)
    // Terminal drivers set s.state directly, so close any open turn here.
    // setState handles ordinary idle and interrupt paths earlier.
    if ((type === 'session.ended' || type === 'session.error') && this.turns.activeTurnId) {
      this.completeTurn(type === 'session.error' ? 'error' : 'ended')
      turnId = null
    }
    this.seq++
    const ev = {
      seq: this.seq,
      ts: new Date().toISOString(),
      type,
      payload,
      ...(turnId ? { turn_id: turnId } : {}),
      ...(ephemeral ? { ephemeral: true } : {}),
    }
    if (this.queue.length >= MAX_QUEUE) {
      if (ephemeral) return ev.seq // shed the new partial; it is superseded anyway
      const idx = this.queue.findIndex((e) => e.ephemeral)
      if (idx >= 0) {
        // Evicting inside an in-flight batch region is safe: delivery removal
        // is by seq, never by position.
        this.queue.splice(idx, 1)
      } else if (this.queue.length % 1000 === 0) {
        // Durables are NEVER dropped (replay is built from them); the queue
        // grows past the cap instead. Growth is self-limiting: user input
        // arrives via the control plane, so a CP outage stops new turns once
        // the current one finishes. Log periodically for diagnosability.
        log(`event queue over cap with ${this.queue.length} durable events pending`)
      }
    }
    this.queue.push(ev)
    this.schedule()
    const changedFiles = this.changedFiles.observe(type, payload)
    if (changedFiles.length > 0 && turnId) {
      this.emit('turn.files_changed', { files: changedFiles }, { turnId })
    }
    return ev.seq
  }

  schedule(delay = FLUSH_MS) {
    if (this.timer || this.inFlight || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, delay)
  }

  async flush() {
    if (this.inFlight || this.stopped || this.queue.length === 0) return
    this.inFlight = true
    const batch = this.queue.slice(0, MAX_BATCH)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ session_id: this.sessionId, events: batch }),
        signal: AbortSignal.timeout(15_000),
      })
      if ([401, 403, 404, 410].includes(res.status)) {
        // Permanent: the session was deleted or the token rotated. Retrying
        // forever would only spam the log and network.
        log(`callback rejected events with ${res.status}; stopping pusher for session ${this.sessionId}`)
        this.queue.length = 0
        this.inFlight = false
        this.stop()
        return
      }
      if (!res.ok) throw new Error(`callback returned ${res.status}`)
      // Remove by seq, not position: emit()'s overflow eviction may have
      // mutated the queue under this await, so positional splice could
      // discard an event that was never sent.
      const lastSeq = batch[batch.length - 1].seq
      while (this.queue.length > 0 && this.queue[0].seq <= lastSeq) this.queue.shift()
      this.retryMs = 1000
      this.inFlight = false
      if (this.queue.length > 0) this.schedule(0)
    } catch (err) {
      this.inFlight = false
      log(`event push failed (${batch.length} events, retry in ${this.retryMs}ms): ${err.message}`)
      this.schedule(this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS)
    }
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  // Best-effort flush, then stop. Used on shutdown and when a finished
  // session is replaced (so no immortal retry loop outlives its session).
  async drain(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (this.queue.length > 0 && !this.stopped && Date.now() < deadline) {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      await this.flush()
      if (this.queue.length > 0) await new Promise((r) => setTimeout(r, 250))
    }
    this.stop()
  }
}

// ---- session ----------------------------------------------------------------------

let session = null
// True while an async startSession() is in flight — the second half of the
// one-session-at-a-time invariant now that create awaits (#1063).
let creating = false

function isDone(s) {
  return s.state === 'ended' || s.state === 'error'
}

// extra fields ride the status payload (#1251: the claude driver stamps
// background_tasks on idle flips so the CP can defer run completion). The
// same-state suppression is unchanged — a count change without a state change
// is the driver's drain re-emit, not a setState.
function setState(s, state, extra = {}) {
  if (isDone(s)) return
  // Start before the working status so the complete provider stream carries
  // one ID. A same-state working call with no active ID is a new turn racing
  // an interrupt; it must still open a boundary.
  if (state === 'working' && !s.pusher.turns.activeTurnId) s.pusher.beginTurn(s.harness)
  if (state === 'idle' && s.pusher.turns.activeTurnId) s.pusher.completeTurn('completed')
  if (s.state === state) return
  s.state = state
  s.pusher.emit('session.status', { state, ...extra })
}

// Rotate a provider-native CLI turn without manufacturing an idle edge. The
// Claude SDK can eagerly consume the next prompt while the prior result is
// waiting for sync(1); the session remains working, but the canonical turn
// boundary still has to advance.
function rotateTurn(s) {
  s.pusher.rotateTurn(s.harness)
}

function isTurnDraining(s) {
  return s.pusher.isTurnDraining()
}

// Resolve every outstanding permission request as a deny. Without this, a
// session ended (or a daemon shut down) while an approval is pending can
// never finish its turn — the SDK keeps the tool call paused on our promise.
function cancelPendingPermissions(s, message) {
  for (const [requestId, p] of s.pending) {
    s.pending.delete(requestId)
    s.pusher.emit('permission.decision', permissionDecisionPayload(requestId, { behavior: 'cancel', message }))
    p.resolve({ behavior: 'deny', message, interrupt: false })
  }
}

// A connector tool escalates (pauses for a human) when the run's policy lists
// its MCP server slug (#731). Tool names surface as mcp__<slug>__<tool>; some
// SDK builds also emit a bare mcp__<slug> — match both.
function isEscalatedTool(toolName, escalateServers) {
  if (!Array.isArray(escalateServers)) return false
  for (const slug of escalateServers) {
    if (toolName === `mcp__${slug}` || toolName.startsWith(`mcp__${slug}__`)) return true
  }
  return false
}

// After a permission or park resolves, drop 'blocked' back to 'working' once
// nothing is outstanding and the turn is still live — the SDK resumes the
// paused tool call(s). setState no-ops if the session already moved on.
function resumeIfUnblocked(s) {
  if (s.state === 'blocked' && s.pending.size === 0 && s.parks.size === 0 && !isDone(s)) {
    setState(s, 'working')
  }
}

// ---- platform tool parks (#803) ---------------------------------------------
//
// A platform tool (sleep, sleep_until) blocks its turn on a promise and emits
// a typed park.request; the control plane records it, the VM idle-suspends
// (the snapshot preserves this promise), and the park-wake sweep resolves it
// at the deadline via POST /parks/{id}/resolve. resultText renders the tool
// result the blocked call returns on wake.

function parkTurn(s, kind, payload, deadline, resultText) {
  const parkId = randomUUID()
  s.pusher.emit('park.request', {
    park_id: parkId,
    kind,
    ...(deadline ? { deadline } : {}),
    payload,
  })
  setState(s, 'blocked')
  return new Promise((resolve) => {
    s.parks.set(parkId, { resolve, kind, deadline: deadline || null, ts: Date.now(), resultText })
  })
}

function resolvePark(s, parkId, message, finalText) {
  const p = s.parks.get(parkId)
  if (!p) return false
  s.parks.delete(parkId)
  s.pusher.emit('park.resolved', { park_id: parkId, resolution: message || '' })
  p.resolve({ content: [{ type: 'text', text: finalText ?? p.resultText(message) }] })
  resumeIfUnblocked(s)
  return true
}

// Resolve every outstanding park with an ABORT result. Mirrors
// cancelPendingPermissions: an ended/interrupted session must never leave the
// SDK waiting on a promise nobody will resolve — but unlike a normal wake,
// the returned text must tell the model to wrap up, not to continue: in
// bypassPermissions nothing else stops the resumed turn from doing more work
// after the end was requested.
function cancelPendingParks(s, message) {
  for (const parkId of [...s.parks.keys()]) {
    resolvePark(s, parkId, message,
      `Sleep aborted: ${message}. Do not start new work — stop now, with at most a one-line note of where you left off.`)
  }
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

// startSession builds the harness-neutral session record and hands the
// harness half to a driver (#1063). Async because the pi SDK's session
// creation is async; handleCreate guards the await window with `creating`.
async function startSession(spec) {
  const s = {
    id: spec.session_id,
    state: 'starting',
    // Unknown non-empty values were already refused by handleCreate (the only
    // caller); empty means claude, the harness that predates the field.
    harness: spec.harness || 'claude',
    sdkSessionId: spec.resume_sdk_session_id || null,
    pending: new Map(), // request_id -> {resolve, toolName, input, ts}
    parks: new Map(), // park_id -> {resolve, kind, deadline, ts, resultText} (#803)
    backgroundTasks: new Map(), // task_id -> {ts, description} (#1251, claude driver)
    // While the home volume is still seeding, the stub driver queues prompt
    // strings. Keep the visible user message in lockstep and emit it only
    // when the real driver opens the canonical turn after seeding.
    deferredMessages: [],
    // Shell calls do not start model turns. Their structured, durable
    // message.context events are also rendered into this queue and appended
    // to the next real user/command prompt so every harness sees the operator
    // injection in conversation context.
    pendingContexts: [],
    // 'command' spans a synchronous slash-command turn; 'shell' spans the
    // immediate subprocess. Both exclude message/command/shell admission so
    // output and turn boundaries cannot interleave ambiguously.
    controlBusy: null,
    pusher: new EventPusher(spec.callback_url, spec.callback_token, spec.session_id),
    lastResult: null,
    ending: false,
    driver: null,
    // The create spec, retained for in-place mutation: the gateway-token
    // refresh endpoint (#1363) rewrites spec.env and the mcp_servers header
    // objects, which the MCP bridge holds BY REFERENCE (connectServer) and
    // which a seed-deferred construction reads later — so a refresh lands no
    // matter when the driver actually constructs.
    spec,
  }

  // The shared machinery drivers reach back into. Passed explicitly so the
  // driver modules stay import-cycle-free and unit-testable.
  const helpers = {
    log,
    syncToDisk,
    setState,
    rotateTurn,
    isTurnDraining,
    isDone,
    textResult,
    parkTurn,
    cancelPendingPermissions,
    resumeIfUnblocked,
    isEscalatedTool,
    VERSION,
    MAX_SLEEP_SECONDS,
  }

  // Seed gate (#1136): a harness must never construct against a half-seeded
  // $HOME — construction already reads it (the pi SDK loads ~/.pi settings)
  // and the spawned harness reads far more. The common case (volume seeded
  // long ago) costs a single readdir. A FAILED seed refuses the create
  // outright with the cause; an in-progress seed accepts the session and
  // defers construction+spawn, so the control plane's create call — and the
  // 20s readiness budget behind it (#715) — never waits on the copy.
  const seed = await seedState()
  if (seed === 'failed') {
    log(`refusing session ${s.id}: ${SEED_FAILED_MESSAGE}`)
    const e = new Error(SEED_FAILED_MESSAGE)
    e.status = 503
    throw e
  }
  if (seed === 'seeding') {
    const queued = []
    s.driver = pendingSeedDriver(s, spec, queued)
    session = s
    emitStarted(s, spec)
    log(`session ${s.id}: home volume still seeding; deferring harness start`)
    void deferStartUntilSeeded(s, spec, helpers, queued)
    return s
  }

  // Publish to the global `session` only once the driver has constructed
  // successfully: a throw here (option validation, model resolution, spawn
  // setup) must not leave a half-initialized, never-done session bricking
  // every future create.
  try {
    s.driver = await constructDriver(s, spec, helpers)
  } catch (err) {
    s.state = 'error'
    log(`session ${s.id} failed to start: ${err?.stack || err}`)
    s.pusher.emit('session.error', { message: String(err?.message || err) })
    s.pusher.drain(3000) // fire-and-forget: deliver the error, then stop
    const e = new Error(`failed to start session: ${err?.message || err}`)
    e.status = err?.status || 502
    throw e
  }
  session = s
  s.state = 'idle'
  emitStarted(s, spec)

  s.driver.start()
  return s
}

function emitStarted(s, spec) {
  s.pusher.emit('session.started', {
    session_id: s.id,
    harness: s.harness,
    model: spec.model || null,
    effort: spec.effort || null,
    permission_mode: spec.permission_mode || 'bypassPermissions',
    resumed_from: spec.resume_sdk_session_id || null,
    durable_user_messages: true,
    daemon_version: VERSION,
  })
}

// pendingSeedDriver stands in for the real driver while the home volume is
// still seeding: it accepts and queues messages (replayed once the real
// harness spawns), applies mode changes to the spec the real driver will
// construct from, and lets end/shutdown finish a session whose harness never
// existed. State stays 'starting' throughout — the truth.
function pendingSeedDriver(s, spec, queued) {
  return {
    harness: s.harness,
    start() {},
    queueMessage(text) {
      if (s.ending) return false
      queued.push(text)
      return true
    },
    async interrupt() {}, // nothing is running yet
    async setPermissionMode(mode) {
      // Mirror the real driver's validation, whichever harness this is:
      // accepting a mode here that deferred construction will reject would
      // 200 the request and then kill the whole session — a fatal error for
      // what is a clean 400 on a running session. The per-harness sets come
      // from the registry, which takes them from the driver modules
      // themselves, so this stub cannot drift from what construction
      // enforces (it did for codex, #1160 review).
      const modes = DRIVERS[s.harness].modes
      if (modes && !modes.has(mode)) {
        throw unsupportedPermissionMode(s.harness, mode)
      }
      spec.permission_mode = mode
    },
    beginEnd() {
      endNeverStartedSession(s)
    },
    async shutdownStop() {
      endNeverStartedSession(s)
    },
  }
}

// The control plane's finalization (EndAgentSession, run finalize, workspace
// release, SSE done) hangs off the session.ended EVENT — session.status
// carrying state 'ended' is deliberately ignored there. A session whose
// harness never spawned must end the way the drivers do or the CP row stays
// live and the VM lingers until idle-suspend.
function endNeverStartedSession(s) {
  if (isDone(s)) return
  s.state = 'ended'
  s.pusher.emit('session.ended', { sdk_session_id: s.sdkSessionId, last_result: s.lastResult })
}

// constructDriver is the ONE harness dispatch. Both construction sites — the
// immediate path and the post-seed deferred path — go through it, because they
// drifted once and the drift was silent: the deferred twin still branched
// pi-or-claude after #1088 added codex, so every codex session that hit the
// seed gate (i.e. every fresh workspace, i.e. every unkeyed run) built a CLAUDE
// driver while `session.started` reported `harness: codex`. The symptom reached
// the user as an OpenAI model id rejected by Anthropic with 404
// model_not_found. The registry table (not an if-chain) is what keeps a fourth
// harness from repeating it: a harness cannot be accepted without a construct.
async function constructDriver(s, spec, helpers) {
  return await DRIVERS[s.harness].construct(s, spec, helpers)
}

async function deferStartUntilSeeded(s, spec, helpers, queued) {
  const st = await waitSeedClear({ cancelled: () => session !== s || isDone(s) || shuttingDown })
  if (session !== s || isDone(s)) return
  if (st !== 'clear') {
    const msg = st === 'failed'
      ? SEED_FAILED_MESSAGE
      : `workspace home volume still seeding after ${SEED_WAIT_MAX_MS / 1000}s — not starting the harness; check the VM console log`
    log(`session ${s.id}: ${msg}`)
    s.state = 'error'
    s.pusher.emit('session.error', { message: msg })
    return
  }
  try {
    s.driver = await constructDriver(s, spec, helpers)
  } catch (err) {
    // An End that landed inside the construction await already went terminal
    // via the stub — don't overwrite 'ended' with 'error' for a session the
    // user closed on purpose.
    if (isDone(s)) return
    s.state = 'error'
    log(`session ${s.id} failed to start after seed wait: ${err?.stack || err}`)
    s.pusher.emit('session.error', { message: String(err?.message || err) })
    return
  }
  if (isDone(s)) {
    // Ended while pi's async construction was in flight: the freshly built
    // harness (SDK session, bridged MCP clients) was never started and nobody
    // else will tear it down.
    try {
      await s.driver.shutdownStop()
    } catch {
      // best-effort
    }
    return
  }
  setState(s, 'idle')
  s.driver.start()
  for (const text of queued.splice(0)) {
    s.driver.queueMessage(text)
    emitUserMessage(s, s.deferredMessages.shift() || { text, attachments: [] })
  }
}

function snapshot(s) {
  return {
    session_id: s.id,
    state: s.state,
    harness: s.harness,
    sdk_session_id: s.sdkSessionId,
    pending_permissions: [...s.pending.entries()].map(([id, p]) => ({
      request_id: id,
      tool_name: p.toolName,
      requested_at: new Date(p.ts).toISOString(),
    })),
    pending_parks: [...s.parks.entries()].map(([id, p]) => ({
      park_id: id,
      kind: p.kind,
      deadline: p.deadline,
      requested_at: new Date(p.ts).toISOString(),
    })),
    last_seq: s.pusher.seq,
    queued_events: s.pusher.queue.length,
    last_result: s.lastResult,
    background_tasks: countBackgroundTasks(s.backgroundTasks),
    active_turn_id: s.pusher.turns.activeTurnId,
  }
}

// ---- Workspace file API (#732) -----------------------------------------------------
//
// List / read / write files under $HOME so the control plane can inspect a
// workspace and collect run deliverables. Raw byte streams (not JSON-base64)
// so large files never buffer in memory; MAX_FILE_BYTES caps writes separately
// from the 1MB JSON body cap. Paths are relative to $HOME and jailed there:
// the CP guards traversal too, but this daemon is the last line — resolve the
// path (and its nearest existing ancestor's realpath, so a symlink inside the
// workspace can't point the write outside) and require it stays under $HOME.

const MAX_FILE_BYTES = 100 * 1024 * 1024
const FILES_ROOT = process.env.HOME || '/home/agent'

// resolveJailed maps a caller-supplied relative path into FILES_ROOT, throwing
// 400 on any escape. Follows the nearest EXISTING ancestor's symlinks (via
// realpath) so `outputs -> /etc` style links can't relocate the operation.
async function resolveJailed(rel) {
  if (typeof rel !== 'string' || rel === '') throw badRequest('path is required')
  if (rel.includes('\0')) throw badRequest('invalid path')
  const abs = pathResolve(FILES_ROOT, rel)
  const root = pathResolve(FILES_ROOT)
  if (abs !== root && !abs.startsWith(root + '/')) throw badRequest('path escapes the workspace')
  // Walk up to the nearest existing ancestor and realpath it: a symlinked
  // directory segment must still land inside the jail.
  let probe = abs
  for (;;) {
    try {
      const real = await realpath(probe)
      if (real !== root && !real.startsWith(root + '/')) throw badRequest('path escapes the workspace')
      break
    } catch (err) {
      if (err?.status) throw err
      if (err?.code !== 'ENOENT') throw err
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return abs
}

function fileType(st) {
  if (st.isSymbolicLink()) return 'symlink'
  if (st.isDirectory()) return 'dir'
  if (st.isFile()) return 'file'
  return 'other'
}

async function handleFileList(res, abs, rel) {
  const names = (await readdir(abs)).sort()
  const entries = []
  for (const name of names) {
    try {
      const st = await lstat(pathResolve(abs, name))
      entries.push({
        name,
        path: rel === '.' ? name : `${rel.replace(/\/+$/, '')}/${name}`,
        type: fileType(st),
        size: st.size,
        modified: st.mtime.toISOString(),
      })
    } catch {
      // dangling symlink or concurrent delete — skip, like sandboxd does
    }
  }
  return send(res, 200, { entries })
}

async function handleFileSearch(res, rootAbs, rootRel, query, extensions, basenames) {
  const entries = await searchWorkspaceFiles(rootAbs, rootRel, query, extensions, basenames)
  return send(res, 200, { entries })
}

async function handleFileRead(res, abs) {
  const st = await lstat(abs)
  if (st.isDirectory()) throw badRequest('path is a directory (use list=true)')
  if (!st.isFile()) throw badRequest('not a regular file')
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(st.size),
  })
  try {
    await pipeline(createReadStream(abs), res)
  } catch {
    // Headers are already out — a JSON error is impossible. Kill the socket
    // so the short body vs content-length surfaces as an error client-side.
    res.destroy()
  }
}

async function handleFileWrite(req, res, abs) {
  await mkdir(dirname(abs), { recursive: true })
  // Write to a sibling temp file and rename into place on success: a failed
  // or oversized upload can neither leave a truncated file behind nor destroy
  // the pre-existing content it was replacing. pipeline() wires error events
  // on every stream (no hang on a disk-full write error) and destroys them
  // all on failure.
  const tmp = `${abs}.zwrm-tmp-${randomUUID().slice(0, 8)}`
  let size = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length
      if (size > MAX_FILE_BYTES) return cb(badRequest('file too large (max 100MB)'))
      cb(null, chunk)
    },
  })
  try {
    await pipeline(req, counter, createWriteStream(tmp, { mode: 0o644, flags: 'wx' }))
    await rename(tmp, abs)
  } catch (err) {
    try { await unlink(tmp) } catch {}
    throw err
  }
  return send(res, 200, { bytes_written: size })
}

async function handleFileDelete(res, abs, recursive) {
  // Deleting the workspace home itself is never what a caller means. Guard on
  // the RESOLVED path, not the raw string: './', 'foo/..', '.' all normalize
  // to FILES_ROOT and would otherwise slip past a string comparison into
  // rm(root, {recursive}).
  if (abs === pathResolve(FILES_ROOT)) throw badRequest('refusing to delete the workspace root')
  const st = await lstat(abs) // 404s via ENOENT if absent
  if (st.isDirectory() && !recursive) throw badRequest('path is a directory (use recursive=true)')
  await rm(abs, { recursive, force: false })
  return send(res, 200, { deleted: true })
}

async function handleFiles(req, res, url) {
  const rel = url.searchParams.get('path') || '.'
  const abs = await resolveJailed(rel)
  try {
    if (req.method === 'GET' && url.searchParams.get('list') === 'true' && url.searchParams.get('search')) {
      return await handleFileSearch(
        res, abs, rel, url.searchParams.get('search'),
        url.searchParams.get('extensions') || '', url.searchParams.get('basenames') || '',
      )
    }
    if (req.method === 'GET' && url.searchParams.get('list') === 'true') return await handleFileList(res, abs, rel)
    if (req.method === 'GET') return await handleFileRead(res, abs)
    if (req.method === 'PUT') return await handleFileWrite(req, res, abs)
    if (req.method === 'DELETE') return await handleFileDelete(res, abs, url.searchParams.get('recursive') === 'true')
  } catch (err) {
    if (err?.code === 'ENOENT') return send(res, 404, { error: 'no such file or directory' })
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return send(res, 403, { error: 'permission denied' })
    throw err
  }
  return send(res, 405, { error: 'method not allowed' })
}

// ---- Skill fetch (#885) --------------------------------------------------------------
// POST /v1/skills/fetch {slug, url, subdir, marker}: download an external
// skill's pinned tarball and extract its subdir into ~/.claude/skills/<slug>/.
// The download happens in-VM by design (licensing: the content flows
// upstream → user VM, never through the platform). The control plane decides
// WHETHER to fetch (managed-marker + pin cache check) — this endpoint only
// does the mechanics, atomically: extract to a sibling temp dir, stamp the
// managed marker, then swap into place.

const MAX_SKILL_TARBALL_BYTES = 32 * 1024 * 1024
const SKILL_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
const execFileP = promisify(execFile)

// Per-slug serialization: session-start seeding can race a dashboard-toggle
// live sync for the same slug; rename(2) can't replace a non-empty dir, so
// the loser would 500 spuriously. The chained job also lets the loser
// cache-hit on the winner's marker instead of re-downloading.
const skillFetchLocks = new Map()

async function handleSkillFetch(req, res) {
  const body = await readBody(req)
  for (const f of ['slug', 'url', 'subdir', 'marker']) {
    if (typeof body[f] !== 'string' || body[f] === '') throw badRequest(`missing ${f}`)
  }
  if (!SKILL_SLUG_RE.test(body.slug)) throw badRequest('invalid slug')
  let srcURL
  try {
    srcURL = new URL(body.url)
  } catch {
    throw badRequest('invalid url')
  }
  if (srcURL.protocol !== 'https:') throw badRequest('url must be https')
  const subdir = body.subdir.replace(/^\/+|\/+$/g, '')
  if (subdir === '' || subdir.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw badRequest('invalid subdir')
  }

  const prev = skillFetchLocks.get(body.slug) || Promise.resolve()
  const job = prev.catch(() => {}).then(() => fetchSkillContent(body, subdir))
  skillFetchLocks.set(body.slug, job)
  try {
    return send(res, 200, await job)
  } finally {
    if (skillFetchLocks.get(body.slug) === job) skillFetchLocks.delete(body.slug)
  }
}

async function fetchSkillContent(body, subdir) {
  const destAbs = await resolveJailed(`.claude/skills/${body.slug}`)
  const skillsDir = dirname(destAbs)

  // A daemon/VM death mid-fetch can leak marker-less temp dirs that the
  // managed-dir reconciliation refuses to touch — and a leaked extract dir
  // carries a SKILL.md the SDK would discover as a phantom skill. Sweep our
  // own leftovers before every fetch.
  try {
    for (const name of await readdir(skillsDir)) {
      if (name.startsWith(`${body.slug}.zwrm-fetch-`)) {
        await rm(pathResolve(skillsDir, name), { recursive: true, force: true }).catch(() => {})
      }
    }
  } catch {
    // skills dir doesn't exist yet — nothing to sweep
  }

  // A racing fetch may have completed while we queued: same marker = same
  // pin, nothing to do.
  try {
    const existing = await readFile(pathResolve(destAbs, '.zwrm-managed'), 'utf8')
    if (existing === body.marker) return { fetched: false, cached: true }
  } catch {
    // absent or unreadable — proceed with the fetch
  }

  const tmpBase = `${destAbs}.zwrm-fetch-${randomUUID().slice(0, 8)}`
  const tarPath = `${tmpBase}.tgz`
  const extractDir = `${tmpBase}.d`
  try {
    const resp = await fetch(body.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
    if (!resp.ok || !resp.body) throw badRequest(`upstream fetch failed: HTTP ${resp.status}`)
    await mkdir(skillsDir, { recursive: true })
    let size = 0
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length
        if (size > MAX_SKILL_TARBALL_BYTES) return cb(badRequest('tarball too large (max 32MB)'))
        cb(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(resp.body), counter, createWriteStream(tarPath, { flags: 'wx' }))

    // Extract only the skill's subdir. The tarball root is "<repo>-<sha>/",
    // so strip that component plus the subdir's own.
    // --no-wildcards-match-slash: without it '*' crosses '/' and the pattern
    // also matches DEEPER occurrences (e.g. examples/vendor/<subdir>/...),
    // polluting the skill dir with mis-stripped foreign files.
    await mkdir(extractDir, { recursive: true })
    const strip = 1 + subdir.split('/').length
    try {
      await execFileP('tar', ['-xzf', tarPath, '-C', extractDir,
        `--strip-components=${strip}`, '--wildcards', '--no-wildcards-match-slash',
        `*/${subdir}/*`], { timeout: 30_000 })
    } catch (err) {
      // tar exits 2 with "Not found in archive" when the subdir vanished at
      // this pin — an actionable 400, not an opaque 500.
      if (`${err?.stderr || ''}`.includes('Not found in archive')) {
        throw badRequest('tarball does not contain the skill subdir (upstream path moved?)')
      }
      throw err
    }
    // Sanity: a skill dir must carry SKILL.md — catches a moved/renamed
    // upstream path before it replaces a working copy.
    try {
      await lstat(pathResolve(extractDir, 'SKILL.md'))
    } catch {
      throw badRequest('fetched skill has no SKILL.md (upstream path moved?)')
    }

    // Marker BEFORE the swap so the dir is born managed.
    await writeFile(pathResolve(extractDir, '.zwrm-managed'), body.marker)
    await rm(destAbs, { recursive: true, force: true })
    await rename(extractDir, destAbs)
    return { fetched: true, bytes: size }
  } finally {
    await rm(tarPath, { force: true }).catch(() => {})
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---- HTTP API ----------------------------------------------------------------------

function badRequest(msg) {
  const e = new Error(msg)
  e.status = 400
  return e
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw badRequest('body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw badRequest('invalid JSON body')
  }
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

async function handleCreate(req, res) {
  const spec = await readBody(req)
  for (const f of ['session_id', 'callback_url', 'callback_token']) {
    if (typeof spec[f] !== 'string' || spec[f] === '') throw badRequest(`missing ${f}`)
  }
  // Fail fast on an unusable callback: otherwise the session starts fine and
  // every event push just dies in the background retry loop.
  let cbURL
  try {
    cbURL = new URL(spec.callback_url)
  } catch {
    throw badRequest('invalid callback_url')
  }
  if (cbURL.protocol !== 'http:' && cbURL.protocol !== 'https:') {
    throw badRequest('callback_url must be http(s)')
  }
  if (spec.permission_mode && !PERMISSION_MODES.has(spec.permission_mode)) {
    throw badRequest(`invalid permission_mode ${spec.permission_mode}`)
  }
  // Empty stays claude: the control plane genuinely sends nothing for it
  // (there is no "claude" row in state.harnessFacts, so SessionHarness returns
  // "" and `omitempty` drops the field). A NON-EMPTY unknown value means the
  // control plane asked for a harness this build cannot host, and the caller's
  // HarnessDaemonCap gate should have caught it. Refuse naming the fix —
  // quietly substituting claude runs the wrong harness on the wrong
  // credentials, which is exactly how a codex session reached Anthropic with
  // an OpenAI model id and came back 404 model_not_found (#1160).
  // Tool policy (#1330): reject an unknown value or a harness whose driver
  // does not enforce it, at create time — accepting and then running the
  // session unrestricted would defeat the policy's whole point. Only the pi
  // driver's gate consults spec.tool_policy today.
  if (spec.tool_policy && !TOOL_POLICIES.has(spec.tool_policy)) {
    throw badRequest(`unknown tool_policy '${spec.tool_policy}' (known: ${[...TOOL_POLICIES].join(', ')})`)
  }
  if (spec.tool_policy && spec.harness !== 'pi') {
    throw badRequest(`tool_policy is only enforced on the pi harness, not '${spec.harness || 'claude'}'`)
  }
  if (spec.harness && !HARNESSES.has(spec.harness)) {
    throw badRequest(
      `this daemon build cannot host the '${spec.harness}' harness ` +
      `(hosts: ${[...HARNESSES].join(', ')}); the VM needs a current agent-base image`,
    )
  }
  // Per-harness mode policy, at create time for BOTH seed states: without this
  // an unsupported mode 400s synchronously on a seeded workspace but 201s on a
  // seeding one and kills the session minutes later when the deferred
  // construction rejects it — after a workspace/VM was already spent.
  {
    const modes = DRIVERS[spec.harness || 'claude'].modes
    if (modes && spec.permission_mode && !modes.has(spec.permission_mode)) {
      throw unsupportedPermissionMode(spec.harness, spec.permission_mode)
    }
  }
  if (creating || (session && !isDone(session))) {
    return send(res, 409, { error: 'a session is already active', active_session: session?.id ?? null })
  }
  // Bound the finished session's pusher (final delivery attempt, then stop)
  // so replaced sessions don't accumulate immortal retry loops.
  if (session) session.pusher.drain(3000)
  // startSession awaits (the pi SDK's create is async): `creating` closes the
  // window where a concurrent create would also pass the active-session check.
  creating = true
  let s
  try {
    s = await startSession(spec)
  } finally {
    creating = false
  }
  send(res, 201, { session_id: s.id, state: s.state })
}

async function handleMessage(req, res, s) {
  const body = await readBody(req)
  let prepared
  try {
    prepared = prepareMessage(body.text, body.attachments)
  } catch (err) {
    throw badRequest(err.message)
  }
  if (s.controlBusy) {
    return send(res, 409, { error: `session is busy with a ${s.controlBusy} request`, state: s.state })
  }
  const pendingCount = s.pendingContexts.length
  const prompt = pendingCount > 0
    ? `${prepared.prompt}\n\n${s.pendingContexts.slice(0, pendingCount).join('\n\n')}`
    : prepared.prompt
  if (isDone(s) || !s.driver.queueMessage(prompt)) {
    return send(res, 409, { error: 'session is not accepting messages', state: s.state })
  }
  if (pendingCount > 0) s.pendingContexts.splice(0, pendingCount)
  const visibleMessage = { text: prepared.text, attachments: prepared.attachments }
  if (s.state === 'starting') s.deferredMessages.push(visibleMessage)
  else emitUserMessage(s, visibleMessage)
  send(res, 202, { queued: true })
}

async function handleCommands(res, s) {
  if (isDone(s)) return send(res, 409, { error: 'session is finished', state: s.state })
  if (s.state === 'starting') return send(res, 409, { error: 'session is still starting', state: s.state })
  if (!supportsCommandDriver(s.driver)) {
    throw badRequest(`commands are not supported by the ${s.harness} harness`)
  }
  const commands = await s.driver.listCommands()
  send(res, 200, { commands })
}

async function handleCommand(req, res, s) {
  const body = await readBody(req)
  let command
  try {
    command = normalizeCommandName(body.command)
  } catch (err) {
    throw badRequest(err.message)
  }
  if (body.arguments != null && typeof body.arguments !== 'string') {
    throw badRequest('arguments must be a string')
  }
  if (body.model != null && typeof body.model !== 'string') {
    throw badRequest('model must be a string')
  }
  if (s.state !== 'idle' || s.controlBusy) {
    return send(res, 409, { error: 'session must be idle before invoking a command', state: s.state })
  }
  if (!supportsCommandDriver(s.driver)) {
    throw badRequest(`commands are not supported by the ${s.harness} harness`)
  }

  // Reserve the turn before the first await. Node may serve another request
  // while supportedCommands/setModel is in flight; without this flag a
  // message could enter between validation and the command prompt.
  s.controlBusy = 'command'
  const pendingCount = s.pendingContexts.length
  try {
    const queued = await s.driver.invokeCommand({
      command,
      arguments: body.arguments || '',
      model: body.model?.trim() || '',
      pendingContext: s.pendingContexts.slice(0, pendingCount),
    })
    if (!queued) {
      s.controlBusy = null
      return send(res, 409, { error: 'session is not accepting commands', state: s.state })
    }
    if (pendingCount > 0) s.pendingContexts.splice(0, pendingCount)
    emitUserMessage(s, {
      text: queued.visible,
      attachments: [],
      source: 'command',
      command,
      arguments: body.arguments || '',
      ...(body.model?.trim() ? { model: body.model.trim() } : {}),
    })
    send(res, 202, { queued: true })
  } catch (err) {
    s.controlBusy = null
    throw err
  }
}

async function handleShell(req, res, s) {
  const body = await readBody(req)
  if (typeof body.command !== 'string' || body.command.trim() === '') {
    throw badRequest('missing command')
  }
  if (body.command.includes('\0')) throw badRequest('command contains a NUL byte')
  // Deliberate policy for #1429: never interleave an operator subprocess with
  // a live model turn (or another control call). Clients retry once idle.
  if (s.state !== 'idle' || s.controlBusy) {
    return send(res, 409, { error: 'session must be idle before running a shell command', state: s.state })
  }
  // Shell output waits for the next real turn. Bound that deferred prompt so
  // repeated automation cannot build an unbounded in-memory/model input while
  // the session stays idle. Existing durable events remain readable; the
  // caller must send a turn before adding more model context.
  const pendingBytes = s.pendingContexts.reduce((total, value) => total + Buffer.byteLength(value), 0)
  if (s.pendingContexts.length >= 8 || pendingBytes >= MAX_SHELL_OUTPUT_BYTES) {
    return send(res, 409, { error: 'send a session turn before adding more shell context', state: s.state })
  }

  s.controlBusy = 'shell'
  try {
    const result = await executeShellCommand(body.command, {
      cwd: s.spec.cwd || process.env.HOME || '/home/agent',
      env: { ...process.env, ...(s.spec.env || {}) },
    })
    await syncToDisk()
    const context = shellContext(result)
    s.pendingContexts.push(context.prompt)
    // Explicit null keeps this operator action outside canonical model turns.
    // It is durable (no ephemeral flag), and the next admitted turn consumes
    // the marked prompt rendering above.
    s.pusher.emit('message.context', context.event, { turnId: null })
    send(res, 200, result)
  } finally {
    s.controlBusy = null
  }
}

function emitUserMessage(s, message) {
  s.pusher.beginTurn(s.harness)
  // Keep the existing event name for rolling-deploy compatibility: older
  // dashboards ignore the new text field while continuing to render files.
  s.pusher.emit('message.context', message)
}

async function handleInterrupt(res, s) {
  // Parks have no SDK abort signal (unlike canUseTool promises): resolve them
  // before interrupting so the aborted turn is never left waiting on one.
  cancelPendingParks(s, 'interrupted; sleep aborted')
  // Close immediately so a message accepted while the driver interrupt is
  // awaiting can open a distinct canonical turn instead of being mislabeled
  // as steering the cancelled one.
  const drainingTurnId = s.pusher.startDrainingTurn('interrupted')
  try {
    await s.driver.interrupt()
  } finally {
    s.pusher.finishDrainingTurn(drainingTurnId)
  }
  send(res, 202, { interrupted: true })
}

async function handlePermission(req, res, s, requestId) {
  const body = await readBody(req)
  if (body.behavior !== 'allow' && body.behavior !== 'deny') {
    throw badRequest('behavior must be "allow" or "deny"')
  }
  const p = s.pending.get(requestId)
  if (!p) return send(res, 404, { error: 'no pending permission request' })
  s.pending.delete(requestId)
  s.pusher.emit('permission.decision', permissionDecisionPayload(requestId, body))
  p.resolve(
    body.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: body.updated_input ?? p.input }
      : { behavior: 'deny', message: body.message || 'denied by user', interrupt: false },
  )
  // The turn resumes once the last outstanding approval clears: blocked ->
  // working, which the CP reads as the run leaving needs_attention (#731).
  resumeIfUnblocked(s)
  send(res, 200, { decided: body.behavior })
}

async function handleParkResolve(req, res, s, parkId) {
  const body = await readBody(req)
  if (!resolvePark(s, parkId, typeof body.message === 'string' ? body.message : '')) {
    return send(res, 404, { error: 'no pending park' })
  }
  send(res, 200, { resolved: true })
}

async function handleMode(req, res, s) {
  const body = await readBody(req)
  if (!PERMISSION_MODES.has(body.mode)) throw badRequest(`invalid mode ${body.mode}`)
  if (isDone(s)) return send(res, 409, { error: 'session is finished', state: s.state })
  await s.driver.setPermissionMode(body.mode)
  s.pusher.emit('session.status', { permission_mode: body.mode })
  send(res, 200, { mode: body.mode })
}

// Gateway-token refresh (#1363, the 'token-refresh' cap): the control plane
// rotates the session's platform credential in place when the 24h-TTL token
// minted at session create would expire under a still-live session. Three
// sinks, all of which resolve the credential late enough for a swap to land:
//  - process.env: pi resolves the "$ZWRM_GATEWAY_TOKEN" apiKey reference from
//    the environment on EVERY completion request, so the next turn simply
//    uses the new token (the daemon hosts one session at a time — process
//    env IS session env, the same contract driver construction relies on).
//  - spec.mcp_servers[*].headers: held by reference by the MCP bridge's
//    transports (connectServer), so bridged connector/skill tools pick the
//    new bearer up on their next request.
//  - spec.env: a seed-deferred driver constructs from the spec AFTER this
//    endpoint may have run; without the rewrite construction would clobber
//    process.env with the stale create-time token.
// Deliberately NOT a general env-update endpoint: the gateway credential is
// platform-owned (secrets/reserved.go) and nothing else needs rotation.
async function handleGatewayToken(req, res, s) {
  const body = await readBody(req)
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if (!token) throw badRequest('missing token')
  process.env.ZWRM_GATEWAY_TOKEN = token
  s.spec.env = { ...(s.spec.env || {}), ZWRM_GATEWAY_TOKEN: token }
  for (const cfg of Object.values(s.spec.mcp_servers || {})) {
    if (cfg && cfg.headers && cfg.headers.Authorization) {
      cfg.headers.Authorization = `Bearer ${token}`
    }
  }
  log(`session ${s.id}: gateway token refreshed`)
  send(res, 200, { refreshed: true })
}

// Graceful end: the current turn finishes (an abrupt stop is what /interrupt
// is for), but nothing may block on a human anymore — pending approvals are
// denied and later tool prompts auto-deny via s.ending.
function handleEnd(res, s) {
  s.ending = true
  cancelPendingPermissions(s, 'session ended')
  cancelPendingParks(s, 'session ended; sleep aborted')
  s.driver.beginEnd()
  send(res, 202, { ending: true })
}

// In-guest memory reclaim (#851): drop the page cache and compact so
// virtio-balloon free page reporting can hand idle memory back to the host
// (FPR only sees FREE pages; cache pins host RSS until dropped). Runs the
// fixed root helper via sudo (the agent user has passwordless sudo). VM-wide
// and session-agnostic — it never touches session state — so it lives beside
// /healthz, not under /v1/sessions. Reports MemFree before/after: that is
// the FPR-visible quantity (MemAvailable barely moves on a cache drop).
function readMemFreeMB() {
  try {
    const m = readFileSync('/proc/meminfo', 'utf8').match(/^MemFree:\s+(\d+) kB/m)
    return m ? Math.round(Number(m[1]) / 1024) : 0
  } catch {
    return 0
  }
}

async function handleReclaim(res) {
  const before = readMemFreeMB()
  await new Promise((resolve, reject) => {
    execFile('sudo', ['/usr/local/sbin/zwrm-reclaim'], { timeout: 10_000 }, (err, _stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`reclaim failed: ${stderr || err.message}`), { status: 500 }))
      else resolve()
    })
  })
  const after = readMemFreeMB()
  log(`reclaim: MemFree ${before} MB -> ${after} MB`)
  send(res, 200, {
    mem_free_mb_before: before,
    mem_free_mb_after: after,
    freed_mb: Math.max(0, after - before),
  })
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!tokenMatches(token)) return send(res, 401, { error: 'unauthorized' })

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(res, 200, {
        ok: true,
        version: VERSION,
        // Capability negotiation: the CP refuses to start sessions that need
        // a feature this daemon build lacks (fail loudly, never drop tools).
        // 'escalation' = the canUseTool policy gate + blocked-state signaling
        // for async human-in-the-loop (#731).
        // 'files' = the workspace file API (#732): list/read/write under $HOME.
        // 'park' = the platform tool park/resolve lifecycle (#803): sleep
        // tools + POST /parks/{id}/resolve.
        // 'reclaim' = POST /reclaim, the in-guest memory reclaim hook (#851).
        // 'skillfetch' = POST /v1/skills/fetch, in-VM download of external
        // skill content (#885).
        // pi-multiprovider (#1149): this daemon routes each session to the
        // provider that owns the model, instead of pinning 'nebius'. The CP
        // refuses a non-nebius model against a daemon without it — workspace
        // VMs keep the image they booted with, so the fleet runs a mix.
        // pi-gateway (#1193): this VM expects its model catalog to name the
        // platform LLM gateway and reads $ZWRM_GATEWAY_TOKEN for the
        // credential — it holds no vendor key. The CP refuses a pi session on
        // a daemon without it, because such a VM has a baked vendor-endpoint
        // catalog and no key to use with it. Implies pi-multiprovider.
        // HARNESS_CAPS (registry-derived, #1160): one same-named cap per
        // hostable harness except claude — 'pi' (#1063, embedded pi SDK) and
        // 'codex' (#1088, `codex app-server` over JSON-RPC; connector tools
        // are not bridged there yet — the driver refuses a session that
        // configures them, #1090). Derived, not listed, so a harness cannot
        // be hostable but unadvertised (the CP would never route it) or
        // advertised but unhostable (every create would 400).
        // 'message-context' (#1297): POST /messages validates and preserves
        // attachment metadata in the model prompt and durable event stream.
        // 'file-search' (#1297): /v1/files performs a bounded local recursive
        // path search, avoiding one CP-to-VM request per directory.
        // 'background-tasks' (#1251): this daemon reports background_tasks
        // below (and on idle session.status payloads), so the CP may trust a
        // zero. Without the cap the CP treats the count as unknown and keeps
        // today's suspend/complete behavior.
        // 'token-refresh' (#1363): POST /v1/sessions/{id}/gateway-token
        // rotates the session's platform credential in place; the CP's
        // admission-time refresh gates on it (a stale daemon would silently
        // keep the expired token).
        // 'commands' (#1429): harness-driver command discovery/invocation.
        // 'shell' (#1429): immediate operator shell with durable context.
        caps: ['mcp', 'escalation', 'files', 'file-search', 'message-context', 'park', 'reclaim', 'skillfetch', 'pi-multiprovider', 'pi-gateway', 'background-tasks', 'tool-policy', 'token-refresh', 'commands', 'shell', ...HARNESS_CAPS],
        active_session: session && !isDone(session) ? session.id : null,
        state: session?.state ?? null,
        // Live background work (#1251): tasks the harness still tracks after
        // a turn's result (background subagents / shells). The idle-suspend
        // sweep and the run reaper defer while this is non-zero.
        background_tasks: session ? countBackgroundTasks(session.backgroundTasks) : 0,
        // 'clear' | 'seeding' | 'failed' — the harness spawn gate (#1136).
        // Informational: the CP never blocks on it, but it explains a session
        // that answers healthz yet sits in 'starting'.
        home_seed: await seedState(),
      })
    }

    if (req.method === 'POST' && url.pathname === '/reclaim') {
      return await handleReclaim(res)
    }

    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'v1' && parts[1] === 'files' && parts.length === 2) {
      return await handleFiles(req, res, url)
    }
    if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'skills' && parts[2] === 'fetch' && parts.length === 3) {
      return await handleSkillFetch(req, res)
    }
    if (parts[0] === 'v1' && parts[1] === 'sessions') {
      if (req.method === 'POST' && parts.length === 2) return await handleCreate(req, res)
      const s = session
      if (!s || s.id !== parts[2]) return send(res, 404, { error: 'no such session' })
      const action = parts[3]
      if (req.method === 'GET' && parts.length === 3) return send(res, 200, snapshot(s))
      if (req.method === 'GET' && action === 'commands' && parts.length === 4) return await handleCommands(res, s)
      if (req.method === 'POST' && action === 'messages' && parts.length === 4) return await handleMessage(req, res, s)
      if (req.method === 'POST' && action === 'command' && parts.length === 4) return await handleCommand(req, res, s)
      if (req.method === 'POST' && action === 'shell' && parts.length === 4) return await handleShell(req, res, s)
      if (req.method === 'POST' && action === 'interrupt' && parts.length === 4) return await handleInterrupt(res, s)
      if (req.method === 'POST' && action === 'permissions' && parts.length === 5) return await handlePermission(req, res, s, parts[4])
      if (req.method === 'POST' && action === 'parks' && parts.length === 6 && parts[5] === 'resolve') return await handleParkResolve(req, res, s, parts[4])
      if (req.method === 'POST' && action === 'mode' && parts.length === 4) return await handleMode(req, res, s)
      if (req.method === 'POST' && action === 'gateway-token' && parts.length === 4) return await handleGatewayToken(req, res, s)
      if (req.method === 'POST' && action === 'end' && parts.length === 4) return handleEnd(res, s)
    }
    send(res, 404, { error: 'not found' })
  } catch (err) {
    if (err?.status) return send(res, err.status, { error: err.message })
    log('request failed:', err?.stack || err)
    if (!res.headersSent) send(res, 500, { error: 'internal error' })
  }
})

// A listen failure (EADDRINUSE from a stale daemon, …) must exit non-zero
// rather than being swallowed by the uncaughtException log-and-continue
// handler — a zombie daemon with no socket looks "launched" to the init.
server.on('error', (err) => {
  console.error(`zwrm-agentd failed to listen on :${PORT}: ${err?.message || err}`)
  process.exit(1)
})
server.listen(PORT, '0.0.0.0', () => {
  log(`zwrm-agentd ${VERSION} listening on :${PORT}`)
})

// Log-and-continue: an unexpected throw from SDK internals must not take down
// the daemon (and with it the HTTP surface) while a session may be salvageable.
// The control plane sees real trouble via session.error events and /healthz.
process.on('unhandledRejection', (err) => log('unhandled rejection:', err?.stack || err))
process.on('uncaughtException', (err) => log('uncaught exception:', err?.stack || err))

let shuttingDown = false
async function shutdown(sig) {
  if (shuttingDown) return
  shuttingDown = true
  log(`${sig}: shutting down`)
  server.close()
  const s = session
  if (s && !isDone(s)) {
    cancelPendingPermissions(s, 'daemon shutting down')
    cancelPendingParks(s, 'daemon shutting down; sleep aborted')
    await s.driver.shutdownStop()
    // Let the driver finish and emit its terminal events BEFORE draining —
    // drain() stops the pusher, after which nothing more can be sent.
    const deadline = Date.now() + 5000
    while (!isDone(s) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  await s?.pusher.drain(5000)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
