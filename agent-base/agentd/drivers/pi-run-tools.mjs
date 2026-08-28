// Platform run tools for the pi harness (#1065): native pi ToolDefinitions
// with the same semantics (and model-facing text) as the claude driver's
// in-process MCP `platform` server (#803) — sleep/sleep_until block the turn
// on a park promise, the VM idle-suspends, and the park-wake sweep resolves
// via the existing POST /parks/{id}/resolve endpoint. Unattended runs only;
// interactive sessions get none (a human is on the stream).

function parkResultToPi(r) {
  return { content: r?.content ?? [{ type: 'text', text: '' }], details: null }
}

export function buildRunTools(s, h) {
  return [
    {
      name: 'sleep',
      label: 'platform: sleep',
      description: `Pause this run for a number of seconds (max ${h.MAX_SLEEP_SECONDS} = 6 hours) and resume exactly here — the VM is suspended while sleeping, so waiting costs nothing. Use this for short waits mid-task (a build farm, a rate limit, a colleague's quick reply). For longer or open-ended waits, do NOT sleep: end your final turn with a precise handoff instead — the conversation can be continued later with full context.`,
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'integer', minimum: 1, maximum: h.MAX_SLEEP_SECONDS, description: 'How long to sleep, in seconds' },
        },
        required: ['seconds'],
      },
      async execute(_id, { seconds }) {
        if (s.ending) throw new Error('session is ending; not sleeping')
        const deadline = new Date(Date.now() + seconds * 1000).toISOString()
        const r = await h.parkTurn(s, 'timer', { seconds }, deadline,
          (msg) => `Woke up: slept ${seconds}s (until ${deadline}).${msg ? ` ${msg}` : ''} Continue the task.`)
        return parkResultToPi(r)
      },
    },
    {
      name: 'sleep_until',
      label: 'platform: sleep_until',
      description: `Pause this run until an ISO-8601 UTC timestamp (at most ${h.MAX_SLEEP_SECONDS} seconds = 6 hours from now) and resume exactly here — the VM is suspended while sleeping. For longer or open-ended waits, end your final turn with a precise handoff instead.`,
      parameters: {
        type: 'object',
        properties: {
          timestamp: { type: 'string', description: 'ISO-8601 timestamp with a timezone, e.g. 2026-07-10T18:00:00Z' },
        },
        required: ['timestamp'],
      },
      async execute(_id, { timestamp }) {
        if (s.ending) throw new Error('session is ending; not sleeping')
        const t = Date.parse(timestamp)
        if (!Number.isFinite(t)) {
          throw new Error('invalid timestamp; use ISO-8601 UTC like 2026-07-10T18:00:00Z')
        }
        const ms = t - Date.now()
        if (ms <= 0) {
          return { content: [{ type: 'text', text: 'that time has already passed; continuing without sleeping' }], details: null }
        }
        if (ms > h.MAX_SLEEP_SECONDS * 1000) {
          throw new Error(`sleep_until is capped at ${h.MAX_SLEEP_SECONDS} seconds from now; for longer waits, end your final turn with a handoff so the run can be continued later`)
        }
        const deadline = new Date(t).toISOString()
        const r = await h.parkTurn(s, 'timer', { timestamp }, deadline,
          (msg) => `Woke up at the requested time (${deadline}).${msg ? ` ${msg}` : ''} Continue the task.`)
        return parkResultToPi(r)
      },
    },
  ]
}
