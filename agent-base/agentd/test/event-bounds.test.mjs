// Event size bounds (#1631): a Read of a PDF put a base64 document block in
// one sdk.user event, its batch went over the control plane's 16 MiB body
// cap, and the pusher resent that batch forever while every later event of
// the session queued behind it.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  boundEventPayload,
  jsonBytes,
  rejectedEventStub,
  MAX_ARRAY_ITEMS,
  MAX_EVENT_PAYLOAD_BYTES,
} from '../event-bounds.mjs'

const MiB = 1 << 20

// The shape the Claude CLI emits for a Read of a PDF: the document as a
// base64 source inside the tool_result, and again in tool_use_result.
function pdfReadResult(base64) {
  return {
    type: 'user',
    session_id: 'sdk-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }],
      }],
    },
    tool_use_result: { type: 'pdf', file: { filePath: '/home/agent/print.pdf', base64, originalSize: 123 } },
  }
}

// The kept prefix and the byte count of a cut string.
function cutOf(s) {
  const m = s.match(/^([\s\S]*)…\[truncated (\d+) bytes\]$/)
  assert.ok(m, `not a cut string: …${s.slice(-40)}`)
  return { kept: m[1], omitted: Number(m[2]) }
}

test('a payload under the cap is returned as is', () => {
  const payload = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x'.repeat(200 << 10) }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }] },
  }
  const before = JSON.stringify(payload)
  const out = boundEventPayload(payload)
  assert.equal(out.shrunk, false)
  assert.equal(out.payload, payload, 'an event under the cap must be the caller’s own object')
  assert.equal(JSON.stringify(out.payload), before)
  assert.equal(out.bytes, Buffer.byteLength(before))
})

test('base64 document and image data is dropped, with the size recorded', () => {
  const base64 = 'A'.repeat(3 * MiB)
  const payload = pdfReadResult(base64)
  payload.message.content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(1000) } })
  const out = boundEventPayload(payload)
  assert.equal(out.shrunk, true)
  assert.ok(out.bytes <= MAX_EVENT_PAYLOAD_BYTES)
  assert.equal(out.bytes, jsonBytes(out.payload))
  assert.equal(out.originalBytes, jsonBytes(payload))

  const p = out.payload
  assert.equal(p.zwrm_truncated, true)
  const source = p.message.content[0].content[0].source
  assert.deepEqual(source, { type: 'base64', media_type: 'application/pdf', data: '', omitted_bytes: 3 * MiB })
  assert.deepEqual(p.message.content[1].source, { type: 'base64', media_type: 'image/png', data: '', omitted_bytes: 1000 })
  // The SDK's duplicate of the file in tool_use_result goes too, and with the
  // file data gone the rest of it fits, so it stays.
  assert.deepEqual(p.tool_use_result.file, { filePath: '/home/agent/print.pdf', base64: '', originalSize: 123, omitted_bytes: 3 * MiB })
  // Everything around the file data survives, so the timeline still shows
  // which tool result this was.
  assert.equal(p.message.content[0].tool_use_id, 'toolu_1')
  assert.equal(p.message.content[0].content[0].type, 'document')
  assert.equal(p.session_id, 'sdk-1')
  assert.equal(p.parent_tool_use_id, null)
})

test('stripping base64 alone leaves ordinary long strings whole', () => {
  // Base64 removal is enough here, so the text next to it is not cut.
  const payload = pdfReadResult('A'.repeat(3 * MiB))
  payload.message.content.push({ type: 'text', text: 'y'.repeat(100 << 10) })
  const out = boundEventPayload(payload)
  assert.equal(out.payload.message.content[1].text.length, 100 << 10)
})

test('tool_use_result is dropped before any of the message is cut', () => {
  // The CLI duplicates tool output in tool_use_result, and nothing past the
  // daemon reads it: it goes whole before the message loses a byte.
  const output = 'o'.repeat(MiB)
  const payload = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: output }] },
    tool_use_result: { stdout: 'o'.repeat(1.5 * MiB), stderr: '' },
  }
  const out = boundEventPayload(payload)
  assert.equal(out.shrunk, true)
  assert.deepEqual(out.payload.tool_use_result, { zwrm_omitted: true, original_bytes: jsonBytes(payload.tool_use_result) })
  assert.equal(out.payload.message.content[0].content, output, 'the tool result itself is untouched')
  assert.equal(out.payload.zwrm_truncated, true)
})

test('long arrays keep their head and a marker item', () => {
  const files = Array.from({ length: 50_000 }, (_, i) => ({ path: `src/generated/file-${i}.ts`, operation: 'modified' }))
  const out = boundEventPayload({ files })
  assert.equal(out.shrunk, true)
  assert.ok(out.bytes <= MAX_EVENT_PAYLOAD_BYTES)
  assert.equal(out.payload.files.length, MAX_ARRAY_ITEMS + 1)
  assert.deepEqual(out.payload.files.slice(0, MAX_ARRAY_ITEMS), files.slice(0, MAX_ARRAY_ITEMS))
  assert.deepEqual(out.payload.files[MAX_ARRAY_ITEMS], { type: 'zwrm_omitted', omitted_items: 50_000 - MAX_ARRAY_ITEMS })
})

test('the largest strings are cut first, so a short one next to them survives', () => {
  // A uniform per-string limit would have cut result too; only the bloat goes.
  const result = 'r'.repeat(100 << 10)
  const log = 'z'.repeat(3 * MiB)
  const out = boundEventPayload({ type: 'result', subtype: 'success', result, log })
  assert.equal(out.shrunk, true)
  assert.ok(out.bytes <= MAX_EVENT_PAYLOAD_BYTES)
  assert.equal(out.payload.result, result)
  assert.equal(out.payload.type, 'result')
  assert.equal(out.payload.subtype, 'success')
  const { kept, omitted } = cutOf(out.payload.log)
  assert.ok(/^z+$/.test(kept))
  assert.equal(kept.length + omitted, log.length)
  // It keeps as much as fits, not a token prefix.
  assert.ok(kept.length > 1.8 * MiB, `${kept.length} bytes kept`)
})

test('a cut never splits a multi-byte character', () => {
  const text = '€'.repeat(MiB) // three UTF-8 bytes each
  const out = boundEventPayload({ text })
  const { kept, omitted } = cutOf(out.payload.text)
  assert.ok(!kept.includes('�'), 'no replacement character from a split sequence')
  assert.ok(/^€+$/.test(kept))
  assert.equal(Buffer.byteLength(kept) + omitted, Buffer.byteLength(text))
})

test('the cap holds however the bytes are spread, escapes included', () => {
  // Forty equal strings are cut to one level together.
  const many = { parts: Array.from({ length: 40 }, (_, i) => ({ i, text: String(i % 10).repeat(100 << 10) })) }
  let out = boundEventPayload(many)
  assert.ok(out.bytes <= MAX_EVENT_PAYLOAD_BYTES, `${out.bytes} bytes`)
  assert.equal(out.payload.parts.length, 40)
  assert.equal(new Set(out.payload.parts.map((p) => cutOf(p.text).kept.length)).size, 1)

  // JSON escaping doubles a quote-heavy string (a tool that printed JSON):
  // the cut is sized by what the string costs in JSON, not by its raw bytes.
  out = boundEventPayload({ text: '"'.repeat(3 * MiB) })
  assert.ok(out.bytes <= MAX_EVENT_PAYLOAD_BYTES, `${out.bytes} bytes`)
  assert.ok(cutOf(out.payload.text).kept.length > 0.9 * MiB, 'it still keeps about as much as fits')

  out = boundEventPayload({ text: '\u0001'.repeat(MiB) }) // six JSON bytes each
  assert.ok(out.bytes <= MAX_EVENT_PAYLOAD_BYTES, `${out.bytes} bytes`)
})

test('the last resort keeps the payload’s identity', () => {
  // Nothing to strip, drop, or cut: the bulk is a very wide object.
  const wide = Object.fromEntries(Array.from({ length: 200_000 }, (_, i) => [`k${i}`, i]))
  const payload = {
    type: 'user',
    subtype: 'x',
    uuid: 'u-1',
    session_id: 'sdk-1',
    parent_tool_use_id: null,
    request_id: 'req-1',
    tool_name: 'Write',
    tool_use_id: 'toolu_3',
    kind: 'question',
    state: 'idle',
    id: 7,
    name: { not: 'a scalar' },
    message: {
      id: 'msg-1',
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_3', is_error: false, content: [{ type: 'text', text: 'body' }] },
        { type: 'tool_use', id: 'toolu_4', name: 'Bash', input: { command: 'ls' } },
        'not a block',
      ],
    },
    input: wide,
  }
  const out = boundEventPayload(payload)
  assert.deepEqual(out.payload, {
    type: 'user',
    subtype: 'x',
    uuid: 'u-1',
    session_id: 'sdk-1',
    parent_tool_use_id: null,
    request_id: 'req-1',
    tool_name: 'Write',
    tool_use_id: 'toolu_3',
    kind: 'question',
    state: 'idle',
    id: 7,
    message: {
      id: 'msg-1',
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_3', is_error: false },
        { type: 'tool_use', id: 'toolu_4', name: 'Bash' },
      ],
    },
    zwrm_truncated: true,
    original_bytes: jsonBytes(payload),
  })
  assert.equal(out.bytes, jsonBytes(out.payload))
})

test('shrinking does not mutate the caller’s payload', () => {
  const base64 = 'A'.repeat(3 * MiB)
  const payload = pdfReadResult(base64)
  payload.extra = { note: 'n'.repeat(3 * MiB) }
  const before = JSON.stringify(payload)
  const out = boundEventPayload(payload)
  assert.equal(out.shrunk, true)
  assert.equal(JSON.stringify(payload), before)
  assert.equal(payload.message.content[0].content[0].source.data, base64)
  assert.equal(payload.tool_use_result.file.base64, base64)
  assert.equal(payload.zwrm_truncated, undefined)
  assert.notEqual(out.payload.message, payload.message)
})

test('an unserializable payload is left for the pusher', () => {
  const cyclic = { a: 1 }
  cyclic.self = cyclic
  const out = boundEventPayload(cyclic)
  assert.equal(out.shrunk, false)
  assert.equal(out.payload, cyclic)
  assert.equal(out.bytes, null)
})

test('a rejected-event stub keeps seq, ts, type, turn and the payload’s identity', () => {
  const ev = { seq: 7, ts: '2026-09-25T09:03:32.000Z', type: 'sdk.user', turn_id: 't1', payload: { big: true } }
  assert.deepEqual(rejectedEventStub(ev, 4242), {
    seq: 7,
    ts: '2026-09-25T09:03:32.000Z',
    type: 'sdk.user',
    turn_id: 't1',
    payload: { zwrm_truncated: true, zwrm_rejected: true, original_bytes: 4242 },
  })
  // A stubbed permission request is still answerable by its id.
  const request = { seq: 8, ts: 'x', type: 'permission.request', payload: { request_id: 'req-9', tool_name: 'Write', tool_use_id: 'toolu_9', input: { content: 'c' } } }
  assert.deepEqual(rejectedEventStub(request, null).payload, {
    request_id: 'req-9', tool_name: 'Write', tool_use_id: 'toolu_9', zwrm_truncated: true, zwrm_rejected: true,
  })
  // Identity is read from scalars only, so a cyclic payload stubs fine.
  const cyclic = { type: 'user' }
  cyclic.self = cyclic
  assert.deepEqual(rejectedEventStub({ seq: 9, ts: 'x', type: 'sdk.user', payload: cyclic }, null).payload, {
    type: 'user', zwrm_truncated: true, zwrm_rejected: true,
  })
})
