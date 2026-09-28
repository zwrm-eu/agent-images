// The session event pusher: stamps every event with the session-monotonic seq
// and the canonical turn, queues it, and delivers the queue to the control
// plane's callback in order (see the event contract atop server.mjs).
//
// The credential broker and the logger are injected so the delivery rules can
// be tested against a fake control plane without booting the daemon.

import { TurnEventContext } from './turn-events.mjs'
import { ChangedFileTracker } from './changed-files.mjs'
import { boundEventPayload, rejectedEventStub, MAX_EVENT_PAYLOAD_BYTES } from './event-bounds.mjs'

// One in-flight batch keeps ordering; the short flush window coalesces token
// partials without adding visible latency.
const FLUSH_MS = 150
export const MAX_BATCH = 200
// A batch also stops at this many serialized bytes (#1631), half the control
// plane's 16 MiB body cap (maxSessionEventsBytes), so a batch of bounded
// events always fits with room to spare. A single event always goes, whatever
// its size: the refusal handling in flush() deals with one that does not fit.
export const MAX_BATCH_BYTES = 8 << 20
// A size refusal lowers the byte budget for the pusher's life, never below
// this: a cap in front of the control plane that is lower than ours then costs
// one refusal cascade, not one per batch.
export const MIN_BATCH_BYTES = 256 << 10
const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30_000
// Beyond this queue depth (control plane unreachable), ephemeral partials are
// dropped oldest-first; durable events are never dropped — they are what
// replay is built from.
const MAX_QUEUE = 50_000

const PERMANENT_STATUSES = [401, 403, 404, 410]

// sizeRefusal says whether the control plane refused a batch for its size:
// resending those bytes can never succeed, so the batch is split instead of
// retried. That is a 413, or the 400 a control plane from before #1631 gave
// for an over-cap body ({"error":"Invalid request body","message":"http:
// request body too large"}), so a daemon ahead of its control plane still
// recovers. Any other 400 is a malformed-body bug that a fix on either side
// clears, and is retried like a 5xx: a refusal never costs a durable event
// the control plane might yet accept.
function sizeRefusal(status, text) {
  return status === 413 || (status === 400 && text.includes('request body too large'))
}

export class EventPusher {
  // broker: the credential broker (request, deactivate). flushMs/retryMs/
  // maxRetryMs exist for tests; the daemon takes the defaults.
  constructor(url, sessionId, { broker, log = () => {}, flushMs = FLUSH_MS, retryMs = INITIAL_RETRY_MS, maxRetryMs = MAX_RETRY_MS } = {}) {
    this.url = url
    this.sessionId = sessionId
    this.broker = broker
    this.log = log
    this.flushMs = flushMs
    this.initialRetryMs = retryMs
    this.maxRetryMs = maxRetryMs
    this.queue = []
    this.seq = 0
    this.timer = null
    this.inFlight = false
    this.retryMs = retryMs
    // Count limit for the next batch: halved while the control plane refuses
    // multi-event batches for size, restored on the first one it accepts.
    this.batchLimit = MAX_BATCH
    // Byte budget per batch: halved on a size refusal, and kept.
    this.batchBytes = MAX_BATCH_BYTES
    // Stubs already standing in for a refused event. A stub is a few hundred
    // bytes, so a size refusal of one is not about its size: it is retried
    // like a 5xx, never stubbed again or dropped.
    this.stubs = new WeakSet()
    // permission.request ids whose event went out shrunk: the client saw a
    // truncated copy of the input, so handlePermission must not run an
    // updated_input echoed back from it (decisionForRequest).
    this.truncatedPermissionRequests = new Set()
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
    // Durable events are bounded here, once, so every batch they ride in is
    // sendable (#1631). Partials are left alone: they are token deltas, and
    // shedding them is always safe.
    let queued = payload
    if (!ephemeral) {
      const bounded = boundEventPayload(payload)
      if (bounded.shrunk) {
        this.log(`event seq ${this.seq} (${type}) for session ${this.sessionId}: payload of ${bounded.originalBytes} bytes is over the ${MAX_EVENT_PAYLOAD_BYTES}-byte cap; shrunk to ${bounded.bytes} bytes`)
        queued = bounded.payload
        this.noteTruncated(type, payload)
      }
    }
    const ev = {
      seq: this.seq,
      ts: new Date().toISOString(),
      type,
      payload: queued,
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
        this.log(`event queue over cap with ${this.queue.length} durable events pending`)
      }
    }
    this.queue.push(ev)
    this.schedule()
    // The tracker reads the payload as the harness produced it, not the
    // bounded copy.
    const changedFiles = this.changedFiles.observe(type, payload)
    if (changedFiles.length > 0 && turnId) {
      this.emit('turn.files_changed', { files: changedFiles }, { turnId })
    }
    return ev.seq
  }

  schedule(delay = this.flushMs) {
    if (this.timer || this.inFlight || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, delay)
  }

  // nextBatch takes events from the head of the queue up to the count limit
  // or the byte budget, whichever comes first, and always at least one. Each
  // event is serialized once, here, and the body is joined from the pieces,
  // so the budget is the exact size of what is sent.
  nextBatch() {
    const head = `{"session_id":${JSON.stringify(this.sessionId)},"events":[`
    const batch = []
    const parts = []
    const sizes = []
    let bytes = Buffer.byteLength(head) + 2
    for (let i = 0; i < this.queue.length && batch.length < this.batchLimit; i++) {
      let ev = this.queue[i]
      let json
      try {
        json = JSON.stringify(ev)
      } catch (err) {
        // A payload with no JSON (a cycle, a BigInt) would fail this batch
        // forever. A partial is dropped (the durable stream supersedes it);
        // a durable event is replaced by its stub.
        if (ev.ephemeral) {
          this.log(`partial seq ${ev.seq} (${ev.type}) for session ${this.sessionId} cannot be serialized (${err.message}); dropping it`)
          this.queue.splice(i, 1)
          i--
          continue
        }
        this.log(`event seq ${ev.seq} (${ev.type}) for session ${this.sessionId} cannot be serialized (${err.message}); sending a stub in its place`)
        ev = this.stubFor(ev, null)
        this.queue[i] = ev
        json = JSON.stringify(ev)
      }
      const size = Buffer.byteLength(json) + (batch.length > 0 ? 1 : 0)
      if (batch.length > 0 && bytes + size > this.batchBytes) break
      batch.push(ev)
      parts.push(json)
      sizes.push(size)
      bytes += size
    }
    return { batch, sizes, bytes, body: `${head}${parts.join(',')}]}` }
  }

  async flush() {
    if (this.inFlight || this.stopped || this.queue.length === 0) return
    this.inFlight = true
    let batch = []
    try {
      const next = this.nextBatch()
      batch = next.batch
      const res = await this.broker.request(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: next.body,
        signal: AbortSignal.timeout(15_000),
      }, this.sessionId)
      if (PERMANENT_STATUSES.includes(res.status)) {
        // Permanent: the session was deleted or the token rotated. Retrying
        // forever would only spam the log and network.
        this.log(`callback rejected events with ${res.status}; stopping pusher for session ${this.sessionId}`)
        this.broker.deactivate(this.sessionId)
        this.queue.length = 0
        this.inFlight = false
        this.stop()
        return
      }
      if (res.status === 400 || res.status === 413) {
        const text = await res.text().catch(() => '')
        if (sizeRefusal(res.status, text) && this.refusedForSize(next, res.status, text.slice(0, 200))) {
          this.inFlight = false
          this.schedule(0)
          return
        }
        // Not about size, or a stub: the same batch again, with backoff.
        throw new Error(`callback returned ${res.status}: ${text.slice(0, 200)}`)
      }
      if (!res.ok) throw new Error(`callback returned ${res.status}`)
      // Remove by seq, not position: emit()'s overflow eviction may have
      // mutated the queue under this await, so positional splice could
      // discard an event that was never sent.
      if (batch.some(e => e.type === 'session.ended' || e.type === 'session.error')) {
        this.broker.deactivate(this.sessionId)
        this.queue.length = 0
        this.inFlight = false
        this.stop()
        return
      }
      const lastSeq = batch[batch.length - 1].seq
      while (this.queue.length > 0 && this.queue[0].seq <= lastSeq) this.queue.shift()
      this.retryMs = this.initialRetryMs
      this.batchLimit = MAX_BATCH
      this.inFlight = false
      if (this.queue.length > 0) this.schedule(0)
    } catch (err) {
      this.inFlight = false
      if (PERMANENT_STATUSES.includes(err.status)) {
        this.log(`callback identity revoked for session ${this.sessionId}: ${err.message}`)
        this.broker.deactivate(this.sessionId)
        this.queue.length = 0
        this.stop()
        return
      }
      this.log(`event push failed (${batch.length} events, retry in ${this.retryMs}ms): ${err.message}`)
      this.schedule(this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs)
    }
  }

  // refusedForSize handles a size refusal of the batch just sent (#1631), and
  // returns false when it cannot, leaving the batch to the backoff retry.
  // Before this, a refused batch was retried byte-for-byte forever, and
  // everything queued behind it (the reply, sdk.result, the idle status) never
  // arrived. Several events: halve the next batch's count and, for good, the
  // byte budget, until one is accepted, which isolates the event the control
  // plane will not take. One event: replace it with a stub under the same
  // seq; a partial (superseded anyway) is dropped instead. A stub is never
  // too large, so its refusal is not handled here. Every step shrinks what
  // is resent, so this ends.
  refusedForSize({ batch, sizes, bytes }, status, detail) {
    const first = batch[0]
    const last = batch[batch.length - 1]
    if (batch.length > 1) {
      this.batchLimit = Math.max(1, Math.floor(batch.length / 2))
      this.batchBytes = Math.min(this.batchBytes, Math.max(MIN_BATCH_BYTES, Math.floor(bytes / 2)))
      this.log(`callback refused ${batch.length} events (seq ${first.seq}-${last.seq}, ${bytes} bytes) with ${status} for session ${this.sessionId}; retrying at most ${this.batchLimit} events and ${this.batchBytes} bytes per batch: ${detail}`)
      return true
    }
    if (this.stubs.has(first)) return false
    // By seq: emit()'s overflow eviction may have moved it under the await.
    const idx = this.queue.findIndex((e) => e.seq === first.seq)
    if (idx < 0) return true
    if (first.ephemeral) {
      this.queue.splice(idx, 1)
      this.log(`callback refused partial seq ${first.seq} (${first.type}, ${sizes[0]} bytes) with ${status} for session ${this.sessionId}; dropping it: ${detail}`)
      return true
    }
    this.queue[idx] = this.stubFor(first, sizes[0])
    this.log(`callback refused event seq ${first.seq} (${first.type}, ${sizes[0]} bytes) with ${status} for session ${this.sessionId}; sending a stub in its place: ${detail}`)
    return true
  }

  // stubFor builds and remembers the stub standing in for ev.
  stubFor(ev, originalBytes) {
    const stub = rejectedEventStub(ev, originalBytes)
    this.stubs.add(stub)
    this.noteTruncated(ev.type, ev.payload)
    return stub
  }

  // noteTruncated remembers a permission request whose event did not go out
  // whole (shrunk at emit, or stubbed), by the id decisions arrive with.
  noteTruncated(type, payload) {
    if (type === 'permission.request' && typeof payload?.request_id === 'string') {
      this.truncatedPermissionRequests.add(payload.request_id)
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
