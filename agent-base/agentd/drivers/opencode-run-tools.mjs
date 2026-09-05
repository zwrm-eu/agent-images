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
import { runSleep, runSleepUntil, mapOutcome, parkText } from './run-tools.mjs'

export const RUN_TOOL_NAMES = ['sleep', 'sleep_until']

// handlePlatformTool executes one run tool. deps: {parkTurn(s, kind, payload,
// deadline, resultText), MAX_SLEEP_SECONDS}. Returns {status, body}; body is
// {text} on success, {error} otherwise. Blocking is the point: the response
// is written when the park resolves. Validation and the park request come
// from the shared run-tools module (#1493); only the HTTP envelope is here.
export async function handlePlatformTool(s, deps, name, args) {
  const run = name === 'sleep' ? runSleep : name === 'sleep_until' ? runSleepUntil : null
  if (!run) return { status: 404, body: { error: `unknown platform tool ${name}` } }
  return mapOutcome(await run(s, deps, args), {
    error: (o) => ({ status: o.ending ? 409 : 400, body: { error: o.error } }),
    text: (text) => ({ status: 200, body: { text } }),
    park: (result) => ({ status: 200, body: { text: parkText(result) } }),
  })
}
