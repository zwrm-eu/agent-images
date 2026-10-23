// Shared platform-tool semantics for every harness (#1493): sleep and
// sleep_until (#803), and wait_for_task (#1911). The claude platform server,
// pi's native tools, codex's dynamic tools and opencode's file tools each
// render their own tool schema and result envelope, but the argument
// validation, the park request and the wake text live here, so the same
// input produces the same park row, the same wake text and the same
// rejection on every harness. A tool schema alone enforces nothing at
// dispatch time: codex coerced "3" and accepted 1.5 and 21601, and pi
// validated nothing at all.

export const ENDING = 'session is ending; not sleeping'
export const ENDING_WAIT = 'session is ending; not waiting'

// The platform tools, by their bare names (pi and opencode use these on the
// wire; claude mounts them under mcp__platform__, codex under
// zwrm__platform__).
export const SLEEP = 'sleep'
export const SLEEP_UNTIL = 'sleep_until'
export const WAIT_FOR_TASK = 'wait_for_task'

// platformToolNames is the one spec gate for every harness: which platform
// tools a session gets. A run (unattended) gets the sleep tools; a chat
// (spec.interactive) never does, since a person is on the stream and a
// sleep would park the VM mid-conversation. Either gets wait_for_task when
// the control plane set spec.task_waits (#1911): it may delegate, and its
// turns may wait for a task's result. prefix renders the harness's own name
// for each (claude, and codex's canonical names: 'mcp__platform__').
export function platformToolNames(spec, prefix = '') {
  const names = []
  if (!spec?.interactive) names.push(SLEEP, SLEEP_UNTIL)
  if (spec?.task_waits === true) names.push(WAIT_FOR_TASK)
  return names.map((n) => prefix + n)
}

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

// The task's later delivery and task_status are the control plane's (#1909,
// #1910); the wording here is what the model is told about them.
export const WAIT_FOR_TASK_DESCRIPTION = (max) =>
  `Wait here for a task you asked another agent for with delegate. Your turn pauses (the VM sleeps meanwhile, at no cost) until the task finishes, its agent asks you a question, or the timeout passes (at most ${max} seconds = ${hours(max)}). It resumes here with what happened. Use it when you can't go on without the result; otherwise carry on or end your turn, and the result comes as a platform message.`

// A task id as delegate returns it: "task_<uuid>". Checked here so a typo
// or a made-up id is refused before the turn parks on it; the control plane
// still checks the task is one this chat or run asked for.
export const TASK_ID_PATTERN = '^task_[A-Za-z0-9-]{1,64}$'
const TASK_ID = new RegExp(TASK_ID_PATTERN)

export const waitForTaskInputSchema = (max) => ({
  type: 'object',
  properties: {
    id: { type: 'string', pattern: TASK_ID_PATTERN, description: 'The task id delegate returned, like task_<uuid>' },
    timeout_seconds: {
      type: 'integer',
      minimum: 1,
      maximum: max,
      description: `How long to wait at most, in seconds (default and max ${max})`,
    },
  },
  required: ['id'],
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

// waitForTaskArgs validates wait_for_task's arguments: the id as delegate
// returned it, and an optional whole-second timeout from 1 to max (absent
// means max). No coercion, as for sleep: "60" is not 60, and null is not
// absent. Returns {id, seconds} or {error}.
export function waitForTaskArgs(args, max) {
  const id = args?.id
  if (typeof id !== 'string' || !TASK_ID.test(id)) {
    return { error: 'id must be the task id delegate returned, like task_<uuid>' }
  }
  const timeout = args?.timeout_seconds
  if (timeout === undefined) return { id, seconds: max }
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > max) {
    return { error: `timeout_seconds must be an integer between 1 and ${max}` }
  }
  return { id, seconds: timeout }
}

// stillRunningText is what a task wait returns when its deadline passed
// with nothing to tell: the control plane resolves the park with an empty
// message then (#1911).
export const stillRunningText = (seconds) =>
  `Stopped waiting after ${seconds}s: the task is still running. Its result will come into this conversation as a platform message when it finishes; task_status shows how it is going. Carry on, or end your turn.`

// runSleep, runSleepUntil and runWaitForTask dispatch one call. h supplies parkTurn(s, kind,
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

// runWaitForTask parks the turn on a task (#1911). The control plane
// resolves the park with the tool's full text when the task finishes or its
// agent asks a question, and with an empty message at the deadline, which
// is when the task is still running.
// MAX_TASK_WAITS bounds the waits one session holds at once: each costs
// the control plane a look per task that moves.
export const MAX_TASK_WAITS = 4

export async function runWaitForTask(s, h, args) {
  if (s.ending) return { error: ENDING_WAIT, ending: true }
  const v = waitForTaskArgs(args, h.MAX_SLEEP_SECONDS)
  if (v.error) return v
  const waiting = [...(s.parks?.values?.() ?? [])].filter((p) => p?.kind === 'task').length
  if (waiting >= MAX_TASK_WAITS) {
    return { error: `at most ${MAX_TASK_WAITS} waits at once: wait for the tasks one after another` }
  }
  const deadline = new Date(Date.now() + v.seconds * 1000).toISOString()
  const result = await h.parkTurn(s, 'task', { task_id: v.id, seconds: v.seconds }, deadline,
    (msg) => msg || stillRunningText(v.seconds))
  return { result }
}

// RUNNERS dispatches a platform tool by its bare name.
export const RUNNERS = { [SLEEP]: runSleep, [SLEEP_UNTIL]: runSleepUntil, [WAIT_FOR_TASK]: runWaitForTask }

// A member's message that comes in while a turn waits for a task ends the
// wait (#1911): the person spoke, so the turn answers them. Timer parks are
// not touched; a run's sleep is the run's own plan.
export const NEW_MESSAGE = 'a new message came in'
export const NEW_MESSAGE_CANCELS = ['task']

// parkCancellation is what a park cancelled for reason (interrupted, session
// ended, …) records and returns, per park kind: the park.resolved
// resolution, and the text the blocked tool call returns. A sleep is told to
// stop: in bypassPermissions nothing else stops the resumed turn from doing
// more work after the end was requested (the text and resolution are the
// ones it has always had). A task wait is told the task goes on and its
// result comes later (#1910); its turn is stopped by the interrupt or end
// itself, or goes on to answer the new message.
export function parkCancellation(kind, reason) {
  if (kind === 'task') {
    return {
      resolution: `${reason}; wait stopped`,
      text: `Stopped waiting: ${reason}. The task keeps running; its result will come into this conversation as a platform message.`,
    }
  }
  const resolution = `${reason}; sleep aborted`
  return {
    resolution,
    text: `Sleep aborted: ${resolution}. Do not start new work — stop now, with at most a one-line note of where you left off.`,
  }
}

// parkCancellations lists what cancelling parks (a Map of park_id ->
// {kind, …}) for reason resolves: every park, or only those of kinds.
export function parkCancellations(parks, reason, kinds = null) {
  const out = []
  for (const [parkId, p] of parks) {
    if (kinds && !kinds.includes(p.kind)) continue
    out.push({ parkId, ...parkCancellation(p.kind, reason) })
  }
  return out
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
