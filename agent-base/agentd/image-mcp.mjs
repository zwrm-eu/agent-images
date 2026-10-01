// Image-declared MCP servers (#1676): an agent image can ship local stdio MCP
// servers that every session gets, on every harness, without the control
// plane knowing about them. The browser template (#1677) uses this to mount
// its `browser` and `computer` tools; agent-base itself ships none, so
// nothing changes for agents on the default images.
//
// One JSON manifest per server in MCP_DIR, filename = slug (the opencode
// run-tools rule: `browser.json` mounts as `browser`, its tools surface as
// mcp__browser__<tool>):
//
//   { "command": "/usr/local/bin/playwright-mcp",   // absolute path, required
//     "args": ["--headless"],                         // optional
//     "env": { "DISPLAY": ":99" },                    // optional
//     "escalate": false }                             // optional, see below
//
// Trust: the directory is baked into the image (root-owned, like
// /etc/opencode). The agent user has passwordless sudo, so ownership checks
// would buy nothing — a manifest is exactly as trusted as anything else the
// session can already run.
//
// The command must be an absolute path to something BAKED into the image:
// the bridges budget connect+list per server (mcp-bridge.mjs), so an `npx`
// that downloads on first use would time out and silently drop the server.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const MCP_DIR = '/etc/zwrm/mcp.d'

// Same shape the MCP gateway enforces for connector slugs
// (mcpgateway/naming.go slugRe), so an image server and a connector live in
// one namespace and tool names stay valid on every harness.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

// Slugs the platform claims in every session: `zwrm` (session server) and
// `platform` (run tools) — mcpgateway/naming.go reservedSlugs.
const RESERVED = new Set(['zwrm', 'platform'])

// loadImageMCPServers reads every manifest in dir and returns
// { servers: {slug: {type:'stdio', command, args, env}}, escalate: [slug] }.
// A missing directory is the normal case (agent-base ships none). An invalid
// manifest is logged and skipped — one bad file must not cost the session its
// other tools, nor fail session creation.
export async function loadImageMCPServers(dir = MCP_DIR, log = () => {}) {
  const servers = {}
  const escalate = []
  let names
  try {
    names = await readdir(dir)
  } catch (err) {
    if (err?.code !== 'ENOENT') log(`image mcp: cannot read ${dir}: ${err?.message || err}`)
    return { servers, escalate }
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const slug = name.slice(0, -'.json'.length)
    try {
      const cfg = parseManifest(slug, await readFile(path.join(dir, name), 'utf8'))
      servers[slug] = cfg.server
      if (cfg.escalate) escalate.push(slug)
    } catch (err) {
      log(`image mcp: skipping ${name}: ${err?.message || err}`)
    }
  }
  return { servers, escalate }
}

// parseManifest validates one manifest. Exported for tests.
export function parseManifest(slug, text) {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid server name '${slug}' (want ${SLUG_RE})`)
  if (RESERVED.has(slug)) throw new Error(`server name '${slug}' is reserved by the platform`)
  const m = JSON.parse(text)
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('manifest must be a JSON object')
  if (typeof m.command !== 'string' || !path.isAbsolute(m.command)) {
    throw new Error('command must be an absolute path')
  }
  if (m.args !== undefined && !(Array.isArray(m.args) && m.args.every((a) => typeof a === 'string'))) {
    throw new Error('args must be an array of strings')
  }
  if (m.env !== undefined && !(m.env && typeof m.env === 'object' && !Array.isArray(m.env) &&
      Object.values(m.env).every((v) => typeof v === 'string'))) {
    throw new Error('env must be an object of strings')
  }
  if (m.escalate !== undefined && typeof m.escalate !== 'boolean') throw new Error('escalate must be a boolean')
  // The claude SDK's McpStdioServerConfig shape; the pi/codex bridge and the
  // opencode config renderer read the same fields.
  const server = { type: 'stdio', command: m.command }
  if (m.args?.length) server.args = [...m.args]
  if (m.env && Object.keys(m.env).length) server.env = { ...m.env }
  return { server, escalate: m.escalate === true }
}

// withImageServers merges image-declared servers into an (already
// broker-activated) session spec. Rules:
//  - a server the control plane sent wins on a slug collision: the CP's set
//    is the agent's configured connectors, the image's is a default;
//  - a session under a tool_policy gets none — the policy confines the
//    platform assistant to driving zwrm, and an image tool would widen it;
//  - `escalate: true` adds the slug to spec.escalate_servers, so on
//    unattended runs the server's tools pause for a human exactly like an
//    escalated connector (isEscalatedTool matches by mcp__<slug> prefix).
//    Every driver short-circuits bypassPermissions before consulting
//    escalate_servers, so a bypass run is switched to auto_approve + 'default'
//    here — what the CP does when a connector escalates (agentrun
//    session_runner.go); session.started reports the mode back to the row.
export function withImageServers(spec, image, log = () => {}) {
  if (spec.tool_policy || Object.keys(image.servers).length === 0) return spec
  const servers = { ...(spec.mcp_servers || {}) }
  const added = []
  for (const [slug, cfg] of Object.entries(image.servers)) {
    if (servers[slug]) {
      log(`image mcp: '${slug}' is shadowed by a connector of the same name`)
      continue
    }
    servers[slug] = cfg
    added.push(slug)
  }
  const escalate = image.escalate.filter((slug) => added.includes(slug))
  const out = { ...spec, mcp_servers: servers }
  if (escalate.length) {
    out.escalate_servers = [...new Set([...(Array.isArray(spec.escalate_servers) ? spec.escalate_servers : []), ...escalate])]
    if (!spec.interactive && (spec.permission_mode || 'bypassPermissions') === 'bypassPermissions') {
      out.auto_approve = true
      out.permission_mode = 'default'
    }
  }
  return out
}
