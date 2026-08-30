// MCP → pi tools bridge (#1065): connects the session's mcp_servers (all
// Streamable-HTTP endpoints on the platform — org connectors via the MCP
// gateway plus the reserved "zwrm" session server) and registers every
// upstream tool as a pi custom tool named `mcp__<server>__<tool>`.
//
// The naming convention is load-bearing: the run escalation policy
// (auto_approve / escalate_servers) matches tools by `mcp__<slug>` prefix in
// the shared gate (isEscalatedTool), so bridged connector tools pause for a
// human exactly like they do on the claude harness.
//
// Failure semantics:
//  - a server that cannot be connected or listed degrades loudly-in-logs but
//    does not fail the session (the claude SDK's per-server behavior);
//  - a call is retried ONCE on a fresh connection, but only for
//    connection-shaped failures — a RequestTimeout or a server-side error
//    must never re-issue a possibly-side-effecting call (send_email twice);
//  - the run's abort signal propagates into every call so an interrupt never
//    waits behind a slow upstream (#1063's hang class, bounded variant).

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'

// isConnectionError separates transport death (safe to reconnect + retry —
// the request never reached, or never returned from, a live server we can
// reason about) from timeouts and server-side errors (retrying could
// duplicate side effects). Exported for tests.
export function isConnectionError(err) {
  if (err?.code === ErrorCode.ConnectionClosed) return true
  return /not connected|connection closed|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|terminated/i
    .test(String(err?.message || err))
}

// mapMCPResult converts an MCP tools/call result into pi's AgentToolResult.
// MCP error results (isError) become thrown Errors — pi renders a thrown
// execute as an error tool result, which is what the model should see.
// Exported for tests.
export function mapMCPResult(result) {
  const content = []
  for (const c of result?.content || []) {
    if (!c || typeof c !== 'object') continue
    if (c.type === 'text' && typeof c.text === 'string') {
      content.push({ type: 'text', text: c.text })
    } else if (c.type === 'image' && typeof c.data === 'string') {
      content.push({ type: 'image', data: c.data, mimeType: c.mimeType || 'image/png' })
    }
    // resource/audio blocks are dropped: no platform tool emits them today,
    // and pi's AgentToolResult has no equivalent.
  }
  if (result?.isError) {
    const msg = content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
    throw new Error(msg || 'tool call failed')
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return { content, details: null }
}

// toolDefinitionFor maps one MCP tool listing to a pi ToolDefinition. pi's
// argument validation accepts plain JSON Schema (validateToolArguments falls
// back to JSON-Schema coercion when the TypeBox kind symbol is absent), so
// the MCP inputSchema passes through unchanged. The execute abort signal is
// forwarded into the MCP call. Exported for tests.
export function toolDefinitionFor(slug, tool, call) {
  const name = `mcp__${slug}__${tool.name}`
  return {
    name,
    label: `${slug}: ${tool.name}`,
    description: tool.description || `${tool.name} (via ${slug})`,
    parameters: tool.inputSchema || { type: 'object', properties: {} },
    async execute(_toolCallId, params, signal) {
      return mapMCPResult(await call(tool.name, params, signal))
    },
  }
}

// connectServer opens a Streamable-HTTP MCP client for one server config
// ({type:'http', url, headers}). Returns null for entries the bridge cannot
// carry (stdio — the platform never sends those to agent sessions). The
// configured headers (the platform bearer) ride every request the transport
// makes — POST, SSE GET, DELETE.
//
// cfg.headers is passed BY REFERENCE, not copied: the SDK transport re-reads
// requestInit.headers on every request, so the gateway-token refresh endpoint
// (#1363) can rotate the platform bearer on a live session by mutating the
// spec's header objects — in-flight calls finish on whatever they sent,
// subsequent requests and reconnects carry the new credential. A defensive
// copy here would silently pin every bridged tool to the create-time token,
// which expires under sessions older than its 24h TTL.
async function connectServer(slug, cfg) {
  if (cfg.type !== 'http' || !cfg.url) return null
  const client = new Client({ name: 'zwrm-agentd-pi-bridge', version: '1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: { headers: cfg.headers || {} },
  })
  await client.connect(transport)
  return client
}

// buildBridgedTools connects every server and returns the pi ToolDefinitions
// for all their tools. Per-server failures are logged and skipped; the
// returned closer tears the clients down at session end.
export async function buildBridgedTools(servers, log) {
  const { entries, close } = await connectServers(servers, log)
  const tools = []
  for (const e of entries) {
    for (const t of e.tools) tools.push(toolDefinitionFor(e.slug, t, e.call))
  }
  return { tools, close }
}

// connectServers is the harness-neutral half of the bridge: it connects every
// server, lists its tools, and returns one entry per server carrying the raw
// MCP tool listings plus a `call(toolName, args, signal)` with the reconnect
// and side-effect-safety rules above. Each harness renders those listings into
// its own tool shape — pi ToolDefinitions here, codex DynamicToolSpecs in
// codex-tools.mjs — so the transport, failure, and retry semantics stay in one
// place and cannot drift between harnesses.
export async function connectServers(servers, log) {
  const entries = []
  const clients = new Map() // slug -> {client, cfg, reconnecting}
  let closed = false

  const callOn = (entry, toolName, args, signal) =>
    entry.client.callTool({ name: toolName, arguments: args || {} }, undefined, { signal })

  // Per-server budget for connect + list: the daemon's create handler runs
  // inline under the CP's 15s HTTP timeout, and a blackholed endpoint must
  // degrade (skip the server) rather than stall session creation. The loser
  // of the race is defused (no unhandled rejection) and a late-completing
  // connect closes its own client instead of leaking it.
  const SETUP_TIMEOUT_MS = 5000
  const setupWithTimeout = async (fn, what, onLate) => {
    let timer
    let timedOut = false
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new Error(`${what} timed out`)) }, SETUP_TIMEOUT_MS)
    })
    const p = fn()
    p.then((v) => { if (timedOut && onLate) onLate(v) }, () => {})
    try {
      return await Promise.race([p, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  for (const [slug, cfg] of Object.entries(servers || {})) {
    let client = null
    try {
      client = await setupWithTimeout(() => connectServer(slug, cfg), `connect ${slug}`,
        (late) => { try { late?.close?.() } catch {} })
      if (!client) {
        log(`mcp bridge: skipping server ${slug} (unsupported type ${cfg.type})`)
        continue
      }
      const listed = await setupWithTimeout(() => client.listTools(), `list ${slug}`)
      const entry = { client, cfg, reconnecting: null }
      clients.set(slug, entry)

      const call = async (toolName, args, signal) => {
        if (closed) throw new Error('bridge closed')
        try {
          return await callOn(entry, toolName, args, signal)
        } catch (err) {
          // Reconnect + retry ONLY for transport death, never after close/
          // abort, never for timeouts or server errors (side-effect safety).
          if (closed || signal?.aborted || !isConnectionError(err)) throw err
          log(`mcp bridge: ${slug}/${toolName} connection failed (${err?.message || err}); reconnecting`)
          // Single-flight: parallel tool calls share one reconnect, so a
          // racing pair can't orphan a client that close() would miss.
          if (!entry.reconnecting) {
            entry.reconnecting = (async () => {
              try { entry.client.close?.() } catch {}
              entry.client = await connectServer(slug, entry.cfg)
            })().finally(() => { entry.reconnecting = null })
          }
          await entry.reconnecting
          if (closed || signal?.aborted) throw err
          return await callOn(entry, toolName, args, signal)
        }
      }

      entries.push({ slug, tools: listed.tools || [], call })
      log(`mcp bridge: ${slug} exposes ${listed.tools?.length ?? 0} tool(s)`)
    } catch (err) {
      // Degrade per-server: the session proceeds without this server's
      // tools, and the log is the diagnosable artifact.
      try { client?.close?.() } catch {}
      log(`mcp bridge: server ${slug} unavailable, skipping: ${err?.message || err}`)
    }
  }

  return {
    entries,
    close() {
      closed = true
      for (const { client } of clients.values()) {
        try { client.close?.() } catch {}
      }
      clients.clear()
    },
  }
}
