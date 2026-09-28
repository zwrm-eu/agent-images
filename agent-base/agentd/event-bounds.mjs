// Size bounds for pushed events (#1631).
//
// A durable event's payload is whatever the harness produced, and a harness
// will happily put a whole file in one: the Claude CLI's Read of a PDF
// returns the document as a base64 content block (and again in
// tool_use_result). The control plane caps an event batch at 16 MiB, so one
// such event used to make its batch unsendable, and every event queued behind
// it was lost. Bounding each event at emit keeps it deliverable; the pusher
// bounds batches on top of that.

// Per-event cap on the serialized payload. Well under the pusher's batch
// budget, so a batch always fits several events, and far above anything but a
// file dump: assistant turns and ordinary tool output never come near it.
export const MAX_EVENT_PAYLOAD_BYTES = 2 << 20
// Arrays longer than this keep their head and a marker item once the cheaper
// steps have not brought a payload under the cap.
export const MAX_ARRAY_ITEMS = 100
// Strings are never cut below this; a payload that still does not fit is
// down to its identity (skeleton below).
const MIN_STRING_BYTES = 256
// An upper bound on one cut string's marker, for choosing the cut level.
const MARKER_BYTES = 32
// Identity strings in a skeleton are ids and names; this only guards the
// skeleton's own size against a pathological one.
const IDENTITY_STRING_BYTES = 256

// The scalars that say what an event is about: the SDK message's own ids,
// a permission request's id and tool, a status event's state. A skeleton
// keeps these so a tool_result stays linked to its tool_use, a
// permission.request stays answerable, and an init keeps its session id.
const IDENTITY_KEYS = ['type', 'subtype', 'uuid', 'session_id', 'request_id', 'tool_name', 'tool_use_id', 'kind', 'state', 'parent_tool_use_id', 'id', 'name']
const MESSAGE_KEYS = ['id', 'type', 'role', 'model']
const BLOCK_KEYS = ['type', 'id', 'tool_use_id', 'name', 'is_error']

// jsonBytes is the UTF-8 size of value's JSON, or null when it has none
// (undefined) or cannot be serialized (a cycle, a BigInt).
export function jsonBytes(value) {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? null : Buffer.byteLength(json)
  } catch {
    return null
  }
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// rewrite walks arrays and plain objects copy-on-write: a container is cloned
// only when something beneath it changed, so an untouched subtree is the
// caller's own object and the caller's payload is never mutated. The visitor
// maps a string, an array before its items are walked (so a long one is cut
// before it is walked), and a plain object after its values were rewritten.
function rewrite(value, visit) {
  if (typeof value === 'string') return visit.string ? visit.string(value) : value
  if (Array.isArray(value)) {
    const arr = visit.array ? visit.array(value) : value
    let out = null
    for (let i = 0; i < arr.length; i++) {
      const next = rewrite(arr[i], visit)
      if (next !== arr[i]) {
        out ??= arr.slice()
        out[i] = next
      }
    }
    return out ?? arr
  }
  if (!isPlainObject(value)) return value
  let out = null
  for (const key of Object.keys(value)) {
    const next = rewrite(value[key], visit)
    if (next !== value[key]) {
      out ??= { ...value }
      out[key] = next
    }
  }
  const obj = out ?? value
  return visit.object ? visit.object(obj) : obj
}

// Content-block sources ({type:'base64', media_type, data}: image and
// document blocks, top level or inside tool_result content) and the SDK's own
// tool-output shape (tool_use_result.file.base64 for Read of an image or PDF)
// lose their encoded bytes; omitted_bytes says how much went.
function stripBase64Node(obj) {
  let omitted = 0
  let out = obj
  if (obj.type === 'base64' && typeof obj.data === 'string' && obj.data !== '') {
    omitted += Buffer.byteLength(obj.data)
    out = { ...out, data: '' }
  }
  if (typeof obj.base64 === 'string' && obj.base64 !== '') {
    omitted += Buffer.byteLength(obj.base64)
    out = { ...out, base64: '' }
  }
  return omitted > 0 ? { ...out, omitted_bytes: omitted } : obj
}

// The marker item is an object with a type, so code walking content blocks
// by type skips it like any block it does not know.
function shortenArray(arr) {
  if (arr.length <= MAX_ARRAY_ITEMS) return arr
  return [...arr.slice(0, MAX_ARRAY_ITEMS), { type: 'zwrm_omitted', omitted_items: arr.length - MAX_ARRAY_ITEMS }]
}

// truncateString keeps the first limit bytes of s, backing off to a UTF-8
// character boundary, and says how much it cut.
function truncateString(s, limit) {
  // Every UTF-16 unit is 1-3 UTF-8 bytes: skip the encode when s cannot be over.
  if (s.length * 3 <= limit) return s
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= limit) return s
  let end = limit
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return `${buf.toString('utf8', 0, end)}…[truncated ${buf.length - end} bytes]`
}

// jsonStringBytes is the size of s inside JSON, quotes aside: what cutting it
// actually saves. Escapes make it up to six times s.length (a control
// character is \u00XX), and a tool that printed JSON is full of them.
function jsonStringBytes(s) {
  return Buffer.byteLength(JSON.stringify(s)) - 2
}

// cutString cuts s so its JSON is about level bytes, scaling the raw cut by
// the string's own escape ratio.
function cutString(s, level) {
  if (s.length * 6 <= level) return s
  const json = jsonStringBytes(s)
  if (json <= level) return s
  return truncateString(s, Math.floor(level * Buffer.byteLength(s) / json))
}

// stringSizes lists the JSON sizes of every string in value longer than min.
function stringSizes(value, min) {
  const sizes = []
  rewrite(value, {
    string: (s) => {
      if (s.length * 6 > min) {
        const n = jsonStringBytes(s)
        if (n > min) sizes.push(n)
      }
      return s
    },
  })
  return sizes
}

// cutLevel is the length the largest strings are cut to so that at least
// need bytes go, cutting as few strings as it can: every string over the
// level is cut to it, and every string under it keeps every byte. So the
// bloat goes first, and a short string that matters (sdk.result's result, a
// file path) survives a huge one next to it. sizes is sorted largest first.
function cutLevel(sizes, need) {
  let sum = 0
  for (let k = 1; k <= sizes.length; k++) {
    sum += sizes[k - 1]
    const level = Math.floor((sum - need - k * MARKER_BYTES) / k)
    if (level >= (sizes[k] ?? 0)) return level
  }
  return 0
}

function identity(obj, keys) {
  const out = {}
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string') out[key] = truncateString(v, IDENTITY_STRING_BYTES)
    else if (v === null || typeof v === 'number' || typeof v === 'boolean') out[key] = v
  }
  return out
}

// skeleton is what a payload is down to when nothing smaller will do: its
// identity scalars, and for an SDK message the identity of each content block
// with the block's content gone.
function skeleton(payload) {
  if (!isPlainObject(payload)) return {}
  const out = identity(payload, IDENTITY_KEYS)
  const message = payload.message
  if (isPlainObject(message)) {
    const m = identity(message, MESSAGE_KEYS)
    if (Array.isArray(message.content)) {
      const content = message.content
      m.content = content.slice(0, MAX_ARRAY_ITEMS).filter(isPlainObject).map((block) => identity(block, BLOCK_KEYS))
      if (content.length > MAX_ARRAY_ITEMS) m.content.push({ type: 'zwrm_omitted', omitted_items: content.length - MAX_ARRAY_ITEMS })
    }
    out.message = m
  }
  return out
}

// marked flags a shrunk payload at the top level so consumers can tell a
// bounded event from a complete one. Anything but a plain object cannot carry
// the flag and is replaced outright (every emit site passes an object).
function marked(value, originalBytes) {
  if (!isPlainObject(value)) return { zwrm_truncated: true, original_bytes: originalBytes }
  return { ...value, zwrm_truncated: true }
}

// boundEventPayload returns payload itself when its JSON fits maxBytes (and
// when it has no JSON to measure: the pusher deals with that at send time).
// Otherwise it returns a shrunk copy, taking each step only while the payload
// is still over: base64 file data goes, then tool_use_result (the CLI's
// duplicate of the tool output, read by nothing downstream), then long
// arrays are cut to their head, then the largest strings are cut, and last
// the payload is reduced to its skeleton. bytes and originalBytes are the
// serialized sizes, for the log.
export function boundEventPayload(payload, maxBytes = MAX_EVENT_PAYLOAD_BYTES) {
  const originalBytes = jsonBytes(payload)
  if (originalBytes === null || originalBytes <= maxBytes) {
    return { payload, shrunk: false, bytes: originalBytes, originalBytes }
  }
  let base = rewrite(payload, { object: stripBase64Node })
  let out = marked(base, originalBytes)
  let bytes = jsonBytes(out)
  const step = (next) => {
    if (bytes <= maxBytes || next === base) return
    base = next
    out = marked(base, originalBytes)
    bytes = jsonBytes(out)
  }
  if (isPlainObject(base) && base.tool_use_result !== undefined) {
    step({ ...base, tool_use_result: { zwrm_omitted: true, original_bytes: jsonBytes(payload.tool_use_result) } })
  }
  if (bytes > maxBytes) step(rewrite(base, { array: shortenArray }))
  if (bytes > maxBytes) {
    const sizes = stringSizes(base, MIN_STRING_BYTES).sort((a, b) => b - a)
    // The level is exact only in JSON bytes, and a cut is made in raw bytes
    // at the string's average escape ratio; what is still over is added to
    // the need and the cut is redone from the uncut strings.
    let need = bytes - maxBytes
    for (let i = 0; i < 4 && bytes > maxBytes && sizes.length > 0; i++) {
      const level = Math.max(MIN_STRING_BYTES, cutLevel(sizes, need))
      out = marked(rewrite(base, { string: (s) => cutString(s, level) }), originalBytes)
      bytes = jsonBytes(out)
      if (level === MIN_STRING_BYTES) break
      need += bytes - maxBytes
    }
  }
  if (bytes > maxBytes) {
    out = { ...skeleton(payload), zwrm_truncated: true, original_bytes: originalBytes }
    bytes = jsonBytes(out)
  }
  if (bytes > maxBytes) {
    out = { zwrm_truncated: true, original_bytes: originalBytes }
    bytes = jsonBytes(out)
  }
  return { payload: out, shrunk: true, bytes, originalBytes }
}

// rejectedEventStub stands in for an event the control plane refused as too
// large on its own: same seq, ts, type and turn, and the payload's skeleton,
// so the stub is still the same tool_result or permission request, not its
// content. It keeps the seq so the timeline has no hole and the stub is
// idempotent on (session_id, seq) like the original. The skeleton reads only
// scalars, so it is safe on a payload that cannot be serialized.
export function rejectedEventStub(ev, originalBytes) {
  return {
    seq: ev.seq,
    ts: ev.ts,
    type: ev.type,
    payload: {
      ...skeleton(ev.payload),
      zwrm_truncated: true,
      zwrm_rejected: true,
      ...(originalBytes != null ? { original_bytes: originalBytes } : {}),
    },
    ...(ev.turn_id ? { turn_id: ev.turn_id } : {}),
  }
}
