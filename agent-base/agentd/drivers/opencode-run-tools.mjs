// Platform run tools for the opencode harness (#1392): sleep/sleep_until with
// the same semantics (and model-facing text) as the claude platform server,
// the pi native tools, and the codex dynamic tools.
//
// The channel differs by necessity: OpenCode offers no daemon-executed tool
// hook, so the tools are FILE TOOLS (templates/agent-base/opencode-tools/,
// baked into the image under /etc/opencode/run/tool) that run inside
// OpenCode's own Bun process and LONG-POLL this daemon's
// /v1/platform-tools/{name} endpoint. A remote-MCP channel was rejected: an
// MCP client enforces its own request timeout (~60s), and a park lasts hours
// — probed with a 65s server-side hold, the file tool's plain fetch survives
// where an MCP call would have timed out. While parked the VM is suspended,
// which freezes the pending request with everything else; on wake it
// resolves and the turn continues exactly where it stopped.
//
// This module is pure dispatch over an injected parkTurn, so `node --test`
// covers the validation and park semantics without booting the daemon.

// The names double as the tool FILENAMES (OpenCode: filename = tool name),
// which keeps the wire names identical to every other harness's — no
// canonicalization needed for run tools.
export const RUN_TOOL_NAMES = ['sleep', 'sleep_until']

// handlePlatformTool executes one run tool. deps: {parkTurn(s, kind, payload,
// deadline, resultText), MAX_SLEEP_SECONDS}. Returns {status, body}; body is
// {text} on success, {error} otherwise. Blocking is the point: the response
// is written when the park resolves.
export async function handlePlatformTool(s, deps, name, args) {
  if (s.ending) return { status: 409, body: { error: 'session is ending; not sleeping' } }
  const max = deps.MAX_SLEEP_SECONDS
  switch (name) {
    case 'sleep': {
      const seconds = args?.seconds
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > max) {
        return { status: 400, body: { error: `seconds must be an integer between 1 and ${max}` } }
      }
      const deadline = new Date(Date.now() + seconds * 1000).toISOString()
      const r = await deps.parkTurn(s, 'timer', { seconds }, deadline,
        (msg) => `Woke up: slept ${seconds}s (until ${deadline}).${msg ? ` ${msg}` : ''} Continue the task.`)
      return { status: 200, body: { text: parkText(r) } }
    }
    case 'sleep_until': {
      const t = Date.parse(args?.timestamp)
      if (!Number.isFinite(t)) {
        return { status: 400, body: { error: 'invalid timestamp; use ISO-8601 UTC like 2026-07-10T18:00:00Z' } }
      }
      const ms = t - Date.now()
      if (ms <= 0) {
        return { status: 200, body: { text: 'that time has already passed; continuing without sleeping' } }
      }
      if (ms > max * 1000) {
        return { status: 400, body: { error: `sleep_until is capped at ${max} seconds from now; for longer waits, end your final turn with a handoff so the run can be continued later` } }
      }
      const deadline = new Date(t).toISOString()
      const r = await deps.parkTurn(s, 'timer', { timestamp: args.timestamp }, deadline,
        (msg) => `Woke up at the requested time (${deadline}).${msg ? ` ${msg}` : ''} Continue the task.`)
      return { status: 200, body: { text: parkText(r) } }
    }
    default:
      return { status: 404, body: { error: `unknown platform tool ${name}` } }
  }
}

function parkText(r) {
  return (r?.content || [])
    .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
}
