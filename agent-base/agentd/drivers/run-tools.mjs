// Shared sleep semantics for every harness (#1493). The claude platform
// server, pi's native tools, codex's dynamic tools and opencode's file tools
// each render their own tool schema and result envelope, but the argument
// validation, the park request and the wake text live here, so the same
// input produces the same park row, the same wake text and the same
// rejection on every harness. A tool schema alone enforces nothing at
// dispatch time: codex coerced "3" and accepted 1.5 and 21601, and pi
// validated nothing at all.

export const ENDING = 'session is ending; not sleeping'

// hours renders the cap for the model-facing text ("6 hours", "1 hour").
const hours = (max) => {
  const h = max / 3600
  return `${h} hour${h === 1 ? '' : 's'}`
}

export const SLEEP_DESCRIPTION = (max) =>
  `Pause this run for a number of seconds (max ${max} = ${hours(max)}) and resume exactly here — the VM is suspended while sleeping, so waiting costs nothing. Use this for short waits mid-task (a build farm, a rate limit, a colleague's quick reply). For longer or open-ended waits, do NOT sleep: end your final turn with a precise handoff instead — the conversation can be continued later with full context.`

export const SLEEP_UNTIL_DESCRIPTION = (max) =>
  `Pause this run until an ISO-8601 UTC timestamp (at most ${max} seconds = ${hours(max)} from now) and resume exactly here — the VM is suspended while sleeping. For longer or open-ended waits, end your final turn with a precise handoff instead.`

export const sleepInputSchema = (max) => ({
  type: 'object',
  properties: {
    seconds: { type: 'integer', minimum: 1, maximum: max, description: 'How long to sleep, in seconds' },
  },
  required: ['seconds'],
})

export const sleepUntilInputSchema = () => ({
  type: 'object',
  properties: {
    timestamp: { type: 'string', description: 'ISO-8601 timestamp with a timezone, e.g. 2026-07-10T18:00:00Z' },
  },
  required: ['timestamp'],
})

// sleepSeconds validates the sleep argument: a whole number of seconds from
// 1 to max, no coercion ("3" is not 3). Returns {seconds} or {error}.
export function sleepSeconds(args, max) {
  const seconds = args?.seconds
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > max) {
    return { error: `seconds must be an integer between 1 and ${max}` }
  }
  return { seconds }
}

// isoWithOffset admits only timestamps that carry their zone (Z or ±hh:mm):
// Date.parse would read an offset-less one as host-local time, and the
// claude schema (z.iso.datetime({ offset: true })) already refuses it.
const isoWithOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i

// sleepUntilDeadline validates the timestamp against the cap. Returns
// {timestamp, deadline}, {text} when the time has already passed (nothing to
// wait for, not an error), or {error}.
export function sleepUntilDeadline(args, max, now = Date.now()) {
  const timestamp = args?.timestamp
  const t = typeof timestamp === 'string' && isoWithOffset.test(timestamp) ? Date.parse(timestamp) : NaN
  if (!Number.isFinite(t)) {
    return { error: 'invalid timestamp; use ISO-8601 UTC like 2026-07-10T18:00:00Z' }
  }
  const ms = t - now
  if (ms <= 0) return { text: 'that time has already passed; continuing without sleeping' }
  if (ms > max * 1000) {
    return { error: `sleep_until is capped at ${max} seconds from now; for longer waits, end your final turn with a handoff so the run can be continued later` }
  }
  return { timestamp, deadline: new Date(t).toISOString() }
}

// runSleep and runSleepUntil dispatch one call. h supplies parkTurn(s, kind,
// payload, deadline, resultText) and MAX_SLEEP_SECONDS. The outcome is one of
//   { error, ending? } rejected before any park; ending marks a session that
//                      is shutting down (opencode answers 409 rather than 400)
//   { text }           nothing to wait for; plain tool text
//   { result }         the park's resolution payload ({ content: [...] })
// and each harness maps it onto its own envelope with mapOutcome.
export async function runSleep(s, h, args) {
  if (s.ending) return { error: ENDING, ending: true }
  const v = sleepSeconds(args, h.MAX_SLEEP_SECONDS)
  if (v.error) return v
  const deadline = new Date(Date.now() + v.seconds * 1000).toISOString()
  const result = await h.parkTurn(s, 'timer', { seconds: v.seconds }, deadline,
    (msg) => `Woke up: slept ${v.seconds}s (until ${deadline}).${msg ? ` ${msg}` : ''} Continue the task.`)
  return { result }
}

export async function runSleepUntil(s, h, args) {
  if (s.ending) return { error: ENDING, ending: true }
  const v = sleepUntilDeadline(args, h.MAX_SLEEP_SECONDS)
  if (v.error !== undefined || v.text !== undefined) return v
  const result = await h.parkTurn(s, 'timer', { timestamp: v.timestamp }, v.deadline,
    (msg) => `Woke up at the requested time (${v.deadline}).${msg ? ` ${msg}` : ''} Continue the task.`)
  return { result }
}

// parkDeadlineError is the mechanism-level guard behind the dispatchers: a
// deadline, when given, must parse and lie between now and the cap (plus a
// minute of slack for the time the dispatcher spent). parkTurn applies it so
// no other caller can create a park the wake sweep would fire at once or
// never. Returns the reason, or null when the deadline is acceptable.
export function parkDeadlineError(deadline, max, now = Date.now()) {
  if (deadline == null) return null
  const t = typeof deadline === 'string' ? Date.parse(deadline) : NaN
  if (!Number.isFinite(t)) return `park deadline ${JSON.stringify(deadline)} is not an ISO-8601 timestamp`
  if (t <= now) return `park deadline ${deadline} is in the past`
  if (t - now > (max + 60) * 1000) return `park deadline ${deadline} exceeds the ${max}s cap`
  return null
}

// mapOutcome renders an outcome through a harness's envelope: on.error(o)
// for a rejection, on.text(text) when there was nothing to wait for, and
// on.park(result) for a park resolution.
export function mapOutcome(o, on) {
  if (o.error) return on.error(o)
  if (o.text !== undefined) return on.text(o.text)
  return on.park(o.result)
}

// parkText flattens a park result's text content for envelopes that carry a
// single string.
export function parkText(r) {
  return (r?.content || [])
    .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
}
