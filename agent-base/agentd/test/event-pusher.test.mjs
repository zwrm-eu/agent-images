// Event delivery against a fake control plane (#1631). The pusher used to
// resend a batch the control plane refused (400 "http: request body too
// large") forever, so one oversized tool result cost the session every event
// after it: the reply, sdk.result, the idle status.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EventPusher, MAX_BATCH, MAX_BATCH_BYTES, MIN_BATCH_BYTES } from '../event-pusher.mjs'
import { MAX_EVENT_PAYLOAD_BYTES } from '../event-bounds.mjs'

const MiB = 1 << 20

// What InternalEvents answers: an over-cap body since #1631, the same before
// it (the exact body the pushers wedged on), and any other decode failure.
const TOO_LARGE_413 = { status: 413, body: '{"error":"Event batch too large","message":"http: request body too large","code":413}\n' }
const OLD_CP_TOO_LARGE_400 = { status: 400, body: '{"error":"Invalid request body","message":"http: request body too large","code":400}\n' }
const MALFORMED_400 = { status: 400, body: '{"error":"Invalid request body","message":"json: cannot unmarshal string into Go struct field Event.events.seq of type int64","code":400}\n' }

// fakeCP answers each POST with respond(events, bytes, n): a status, or
// {status, body}. It records every post and what was accepted. Bodies are
// parsed the way the control plane reads them, so a malformed one fails.
function fakeCP(respond) {
  const cp = {
    posts: [],
    delivered: [],
    deactivated: [],
    logs: [],
    broker: {
      async request(url, init, sessionID) {
        assert.equal(url, 'http://cp/events')
        assert.equal(sessionID, 'sess-1')
        const bytes = Buffer.byteLength(init.body)
        const { session_id: sid, events } = JSON.parse(init.body)
        assert.equal(sid, 'sess-1')
        let answer = respond(events, bytes, cp.posts.length)
        if (typeof answer === 'number') answer = { status: answer, body: answer === 200 ? '{"status":"ok"}' : `{"error":"failed","code":${answer}}` }
        // A stub is recorded as -seq, so a test can tell it from the original.
        cp.posts.push({ seqs: events.map((e) => (e.payload?.zwrm_rejected ? -e.seq : e.seq)), bytes, status: answer.status })
        if (answer.status === 200) cp.delivered.push(...events)
        return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } })
      },
      deactivate(sessionID) {
        cp.deactivated.push(sessionID)
      },
    },
  }
  cp.pusher = new EventPusher('http://cp/events', 'sess-1', {
    broker: cp.broker,
    log: (...args) => cp.logs.push(args.join(' ')),
    flushMs: 0,
    retryMs: 1,
    maxRetryMs: 4,
  })
  return cp
}

// settled resolves once the pusher has nothing queued and nothing in flight.
async function settled(pusher, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (pusher.queue.length > 0 || pusher.inFlight) {
    if (Date.now() > deadline) throw new Error(`pusher did not settle: ${pusher.queue.length} queued`)
    await new Promise((r) => setTimeout(r, 1))
  }
}

const text = (bytes) => ({ text: 'x'.repeat(bytes) })

// A control plane with a body cap, answering an over-cap body with refusal.
const capped = (limit, refusal) => (events, bytes) => (bytes > limit ? refusal : 200)

test('batches stop at the byte budget as well as the count', async () => {
  const cp = fakeCP(() => 200)
  // 1.5 MiB each: under the per-event cap, so unshrunk, and five fill the
  // 8 MiB budget.
  for (let i = 0; i < 6; i++) cp.pusher.emit('sdk.user', text(1.5 * MiB))
  await settled(cp.pusher)
  assert.deepEqual(cp.posts.map((p) => p.seqs), [[1, 2, 3, 4, 5], [6]])
  for (const p of cp.posts) assert.ok(p.bytes <= MAX_BATCH_BYTES, `${p.bytes} bytes`)
  assert.equal(cp.delivered[0].payload.text.length, 1.5 * MiB)

  const small = fakeCP(() => 200)
  for (let i = 0; i < MAX_BATCH + 50; i++) small.pusher.emit('sdk.assistant', { n: i })
  await settled(small.pusher)
  assert.deepEqual(small.posts.map((p) => p.seqs.length), [MAX_BATCH, 50])
})

test('a durable event over the cap is shrunk at emit; the driver’s object is untouched', async () => {
  const cp = fakeCP(() => 200)
  const data = 'A'.repeat(20 * MiB)
  const msg = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }] }] } }
  cp.pusher.emit('sdk.user', msg)
  cp.pusher.emit('sdk.partial', { chunk: 'y'.repeat(3 * MiB) }, { ephemeral: true })
  await settled(cp.pusher)
  assert.equal(msg.message.content[0].content[0].source.data, data)
  const [user, partial] = cp.delivered
  assert.equal(user.payload.zwrm_truncated, true)
  assert.equal(user.payload.message.content[0].content[0].source.omitted_bytes, 20 * MiB)
  assert.ok(Buffer.byteLength(JSON.stringify(user.payload)) <= MAX_EVENT_PAYLOAD_BYTES)
  // Partials are not bounded.
  assert.equal(partial.payload.chunk.length, 3 * MiB)
  assert.ok(cp.logs.some((l) => /event seq 1 \(sdk\.user\) for session sess-1: payload of \d+ bytes is over/.test(l)))
})

test('a permission request that went out shrunk is remembered by its request id', async () => {
  const cp = fakeCP(() => 200)
  cp.pusher.emit('permission.request', { request_id: 'req-big', tool_name: 'Write', input: { file_path: 'a', content: 'c'.repeat(3 * MiB) } })
  cp.pusher.emit('permission.request', { request_id: 'req-small', tool_name: 'Write', input: { file_path: 'b', content: 'c' } })
  await settled(cp.pusher)
  assert.deepEqual([...cp.pusher.truncatedPermissionRequests], ['req-big'])
  assert.equal(cp.delivered[0].payload.request_id, 'req-big', 'the shrunk request still carries its id')
})

for (const refusal of [TOO_LARGE_413, OLD_CP_TOO_LARGE_400]) {
  const name = refusal.status === 413 ? '413' : 'the old control plane’s 400 "request body too large"'

  test(`${name} on a multi-event batch splits it and lowers the byte budget`, async () => {
    // Six 1 MiB events fit the pusher's 8 MiB budget but not a 4.5 MiB cap.
    const cp = fakeCP(capped(4.5 * MiB, refusal))
    for (let i = 0; i < 6; i++) cp.pusher.emit('sdk.user', text(MiB))
    await settled(cp.pusher)
    // Half the refused bytes carries two of these events, not three.
    assert.deepEqual(cp.posts.map((p) => [p.seqs, p.status]), [
      [[1, 2, 3, 4, 5, 6], refusal.status],
      [[1, 2], 200],
      [[3, 4], 200],
      [[5, 6], 200],
    ])
    assert.deepEqual(cp.delivered.map((e) => e.seq), [1, 2, 3, 4, 5, 6])
    for (const e of cp.delivered) assert.equal(e.payload.text.length, MiB, 'split batches carry the events whole')
    assert.equal(cp.pusher.batchLimit, MAX_BATCH, 'the count limit is restored after an accepted batch')
    assert.equal(cp.pusher.batchBytes, Math.floor(cp.posts[0].bytes / 2), 'the byte budget stays lowered')
    assert.ok(cp.logs.some((l) => l.includes('callback refused 6 events (seq 1-6,') && l.includes(`with ${refusal.status} for session sess-1`)))
  })

  test(`${name} on a single event sends a stub under its seq; nothing after it is lost`, async () => {
    // A cap below one event's size: the event itself is unsendable.
    const cp = fakeCP(capped(MiB, refusal))
    cp.pusher.emit('turn.started', { turn_id: 't1' }, { turnId: 't1' })
    cp.pusher.emit('sdk.user', { type: 'user', uuid: 'u-2', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(1.5 * MiB) }] } }, { turnId: 't1' })
    cp.pusher.emit('sdk.assistant', { message: { content: [{ type: 'text', text: 'the reply' }] } }, { turnId: 't1' })
    cp.pusher.emit('sdk.result', { subtype: 'success', result: 'done' }, { turnId: 't1' })
    cp.pusher.emit('session.status', { state: 'idle' })
    await settled(cp.pusher)

    assert.deepEqual(cp.delivered.map((e) => e.seq), [1, 2, 3, 4, 5], 'in order, no gap, no duplicate')
    const stub = cp.delivered[1]
    assert.equal(stub.type, 'sdk.user')
    assert.equal(stub.turn_id, 't1')
    assert.equal(stub.payload.zwrm_truncated, true)
    assert.equal(stub.payload.zwrm_rejected, true)
    assert.ok(stub.payload.original_bytes > 1.5 * MiB)
    // The stub is still the same tool result, linked to its tool_use.
    assert.equal(stub.payload.uuid, 'u-2')
    assert.deepEqual(stub.payload.message.content, [{ type: 'tool_result', tool_use_id: 'toolu_1' }])
    assert.deepEqual(cp.delivered[2].payload.message.content[0], { type: 'text', text: 'the reply' })
    assert.deepEqual(cp.delivered[3].payload, { subtype: 'success', result: 'done' })
    assert.deepEqual(cp.delivered[4].payload, { state: 'idle' })
    // The split isolates the event (the lowered byte budget sends 1 alone);
    // once refused alone it is only ever sent as its stub (-2).
    assert.deepEqual(cp.posts.map((p) => [p.seqs, p.status]), [
      [[1, 2, 3, 4, 5], refusal.status],
      [[1], 200],
      [[2], refusal.status],
      [[-2, 3, 4, 5], 200],
    ])
    assert.ok(cp.logs.some((l) => l.includes('callback refused event seq 2 (sdk.user,') && l.includes('sending a stub in its place')))
  })
}

test('any other 400 is retried like a 5xx and never costs an event', async () => {
  // A control plane with a decode bug refuses every body for a while; nothing
  // may be stubbed or dropped, and all of it arrives once it is fixed.
  let queuedWhileFailing = null
  const cp = fakeCP((events, bytes, n) => {
    if (n < 4) {
      queuedWhileFailing = cp.pusher.queue.length
      return MALFORMED_400
    }
    return 200
  })
  const payloads = [{ n: 0 }, { n: 1, text: 'x'.repeat(MiB) }, { n: 2 }]
  for (const p of payloads) cp.pusher.emit('sdk.assistant', p)
  await settled(cp.pusher)
  assert.deepEqual(cp.posts.map((p) => [p.seqs, p.status]), [
    [[1, 2, 3], 400],
    [[1, 2, 3], 400],
    [[1, 2, 3], 400],
    [[1, 2, 3], 400],
    [[1, 2, 3], 200],
  ])
  assert.equal(queuedWhileFailing, 3, 'the events stay queued while refused')
  assert.deepEqual(cp.delivered.map((e) => e.payload), payloads)
  assert.equal(cp.pusher.batchLimit, MAX_BATCH)
  assert.equal(cp.pusher.batchBytes, MAX_BATCH_BYTES, 'a non-size refusal leaves the budget alone')
  // With backoff: 1, 2, 4 (the test cap), 4 ms.
  const retries = cp.logs.filter((l) => l.startsWith('event push failed')).map((l) => Number(l.match(/retry in (\d+)ms/)[1]))
  assert.deepEqual(retries, [1, 2, 4, 4])
  assert.ok(cp.logs.some((l) => l.includes('callback returned 400: {"error":"Invalid request body","message":"json: cannot unmarshal')))
})

test('a size refusal of a stub is retried with backoff, never dropped', async () => {
  // A stub is a few hundred bytes, so "too large" for one is the control
  // plane misbehaving: the stub waits for it rather than leaving a hole.
  const cp = fakeCP((events, bytes, n) => (n < 7 && events.some((e) => e.seq === 2) ? TOO_LARGE_413 : 200))
  for (let i = 0; i < 4; i++) cp.pusher.emit('sdk.assistant', { n: i })
  await settled(cp.pusher)
  assert.deepEqual(cp.delivered.map((e) => e.seq), [1, 2, 3, 4])
  assert.equal(cp.delivered[1].payload.zwrm_rejected, true)
  assert.deepEqual(cp.posts.map((p) => [p.seqs, p.status]), [
    [[1, 2, 3, 4], 413],
    [[1, 2], 413],
    [[1], 200],
    [[2, 3, 4], 413],
    [[2], 413],
    [[-2], 413],
    [[-2], 413],
    [[-2], 200],
    [[3, 4], 200],
  ])
  assert.ok(!cp.logs.some((l) => l.includes('dropping')))
  assert.equal(cp.logs.filter((l) => l.startsWith('event push failed (1 events')).length, 2)
})

test('a partial refused for size is dropped rather than stubbed', async () => {
  // A partial is superseded by its complete message, so it has no stand-in.
  const cp = fakeCP((events) => (events.some((e) => e.payload?.bad) ? TOO_LARGE_413 : 200))
  cp.pusher.emit('sdk.assistant', { n: 1 })
  cp.pusher.emit('sdk.partial', { bad: true }, { ephemeral: true })
  cp.pusher.emit('sdk.assistant', { n: 3 })
  await settled(cp.pusher)
  assert.deepEqual(cp.delivered.map((e) => e.seq), [1, 3])
  assert.ok(!cp.posts.some((p) => p.seqs.includes(-2)))
})

test('an event with no JSON is stubbed if durable, and dropped if a partial', async () => {
  const cp = fakeCP(() => 200)
  cp.pusher.emit('sdk.assistant', { n: 1 })
  cp.pusher.emit('sdk.assistant', { type: 'assistant', uuid: 'u-2', n: 2n }, { turnId: 't1' })
  cp.pusher.emit('sdk.partial', { n: 3n }, { ephemeral: true })
  cp.pusher.emit('sdk.assistant', { n: 4 })
  await settled(cp.pusher)
  assert.deepEqual(cp.delivered.map((e) => e.seq), [1, 2, 4])
  assert.equal(cp.delivered[1].turn_id, 't1')
  assert.equal(cp.delivered[1].ephemeral, undefined)
  assert.deepEqual(cp.delivered[1].payload, { type: 'assistant', uuid: 'u-2', zwrm_truncated: true, zwrm_rejected: true })
  assert.deepEqual(cp.delivered[2].payload, { n: 4 })
  assert.ok(cp.logs.some((l) => l.includes('partial seq 3 (sdk.partial)') && l.includes('dropping it')))
})

test('a cap below ours costs one refusal cascade, not one per batch', async () => {
  // 700 KiB events against a 3 MiB cap: once the budget has come down, every
  // later batch fits first time and still carries more than one event.
  const cp = fakeCP(capped(3 * MiB, TOO_LARGE_413))
  for (let i = 0; i < 12; i++) cp.pusher.emit('sdk.user', text(700 << 10))
  await settled(cp.pusher)
  const firstAccepted = cp.posts.findIndex((p) => p.status === 200)
  assert.ok(firstAccepted > 0)
  assert.ok(cp.posts.slice(0, firstAccepted).every((p) => p.status === 413))
  assert.ok(cp.posts.slice(firstAccepted).every((p) => p.status === 200 && p.seqs.length > 1), JSON.stringify(cp.posts.map((p) => [p.seqs, p.status])))
  assert.deepEqual(cp.delivered.map((e) => e.seq), Array.from({ length: 12 }, (_, i) => i + 1))
  assert.ok(cp.pusher.batchBytes < 3 * MiB && cp.pusher.batchBytes >= MIN_BATCH_BYTES)
})

test('a 500 retries the same batch with backoff', async () => {
  const cp = fakeCP((events, bytes, n) => (n < 2 ? 500 : 200))
  for (let i = 0; i < 3; i++) cp.pusher.emit('sdk.assistant', { n: i })
  await settled(cp.pusher)
  assert.deepEqual(cp.posts.map((p) => [p.seqs, p.status]), [
    [[1, 2, 3], 500],
    [[1, 2, 3], 500],
    [[1, 2, 3], 200],
  ])
  assert.deepEqual(cp.delivered.map((e) => e.payload), [{ n: 0 }, { n: 1 }, { n: 2 }])
  assert.ok(!cp.delivered.some((e) => e.payload.zwrm_rejected), 'a server error never stubs')
})

test('events emitted while a refused batch is in flight still arrive in order', async () => {
  let emitted = false
  const cp = fakeCP((events, bytes) => {
    if (!emitted) {
      // The driver keeps producing while the pusher waits on the callback.
      emitted = true
      cp.pusher.emit('sdk.assistant', { late: 1 })
      cp.pusher.emit('sdk.result', { late: 2 })
    }
    return bytes > MiB ? TOO_LARGE_413 : 200
  })
  cp.pusher.emit('sdk.user', text(800 << 10))
  cp.pusher.emit('sdk.user', text(1.5 * MiB))
  cp.pusher.emit('sdk.user', text(800 << 10))
  await settled(cp.pusher)
  assert.deepEqual(cp.delivered.map((e) => e.seq), [1, 2, 3, 4, 5])
  assert.equal(cp.delivered[1].payload.zwrm_rejected, true)
  assert.equal(cp.delivered[2].payload.text.length, 800 << 10)
  assert.deepEqual(cp.delivered[4].payload, { late: 2 })
})

test('401/403/404/410 still stop the pusher for good', async () => {
  for (const status of [401, 403, 404, 410]) {
    const cp = fakeCP(() => status)
    cp.pusher.emit('sdk.assistant', { n: 1 })
    cp.pusher.emit('sdk.assistant', { n: 2 })
    await settled(cp.pusher)
    assert.equal(cp.posts.length, 1)
    assert.equal(cp.pusher.stopped, true)
    assert.deepEqual(cp.deactivated, ['sess-1'])
  }
})
