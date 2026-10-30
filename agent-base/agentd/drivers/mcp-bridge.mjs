// MCP → pi tools bridge (#1065): connects the session's mcp_servers
// (Streamable-HTTP endpoints on the platform — org connectors via the MCP
// gateway plus the reserved "zwrm" session server — and the image's local
// stdio servers, #1676) and registers every upstream tool as a pi custom
// tool named `mcp__<server>__<tool>`.
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
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'

// How long close() waits for the bridged servers to go (#2004); the stdio
// transport's own SIGTERM-then-SIGKILL escalation fits inside it.
const BRIDGE_CLOSE_MS = 5000

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
//
// opts.deferred marks the tool deferred (#2026): pi leaves it out of the
// tools declared to the model until tool_search loads it, and searches it
// under the server's namespace, `mcp__<slug>`. Not with the server's
// instructions: tool_search adds a namespace's text to each of its tools'
// search text, where words every tool shares only make unrelated tools
// match.
export function toolDefinitionFor(slug, tool, call, opts = {}) {
  const name = `mcp__${slug}__${tool.name}`
  return {
    name,
    label: `${slug}: ${tool.name}`,
    description: tool.description || `${tool.name} (via ${slug})`,
    parameters: tool.inputSchema || { type: 'object', properties: {} },
    ...(opts.deferred ? { exposure: 'deferred', namespace: { name: `mcp__${slug}` } } : {}),
    async execute(_toolCallId, params, signal) {
      return mapMCPResult(await call(tool.name, params, signal))
    },
  }
}

// connectServer opens an MCP client for one server config: Streamable-HTTP
// ({type:'http', url, headers}) or a local stdio child ({type:'stdio',
// command, args, env} — image-declared servers, #1676). Returns null for
// entries the bridge cannot carry. For HTTP, the configured headers (the
// platform bearer) ride every request the transport makes — POST, SSE GET,
// DELETE.
//
// cfg.headers is passed BY REFERENCE, not copied: the SDK transport re-reads
// requestInit.headers on every request, so the gateway-token refresh endpoint
// (#1363) can rotate the platform bearer on a live session by mutating the
// spec's header objects — in-flight calls finish on whatever they sent,
// subsequent requests and reconnects carry the new credential. A defensive
// copy here would silently pin every bridged tool to the create-time token,
// which expires under sessions older than its 24h TTL.
//
// A stdio child inherits the daemon's environment, then the session env
// (opts.env), then the manifest's env — the claude CLI and opencode spawn
// theirs from the same layering — and starts in the session cwd; its stderr lands in the daemon log. Reconnect after transport
// death respawns it.
async function connectServer(slug, cfg, opts = {}) {
  let transport
  if (cfg.type === 'http' && cfg.url) {
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers || {} },
    })
  } else if (cfg.type === 'stdio' && cfg.command) {
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args || [],
      env: { ...process.env, ...(opts.env || {}), ...(cfg.env || {}) },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      stderr: 'inherit',
    })
  } else {
    return null
  }
  const client = new Client({ name: 'zwrm-agentd-pi-bridge', version: '1.0' })
  await client.connect(transport)
  return client
}

// The platform's own session server (memory, skills, tasks, delegation): its
// tools are always declared, whatever the budget. So are the image's own
// stdio servers (#1676, e.g. a browser template's browser): they are what
// the template is for.
const PLATFORM_SERVER = 'zwrm'

// The connector tool definitions (name, description and input schema, as
// JSON) declared to the model with every request are kept within a budget
// (#2026). pi resends every declared tool with each request, so one large
// connector made every step expensive: an agent with Microsoft 365's 323
// tools (~1.7M characters) sent ~218k tokens per call before it had said
// anything. Like Claude Code's tool search, the budget is a tenth of the
// model's context window (at ~4 characters a token), between 40k and 160k
// characters. Connectors are declared smallest first while they fit; the
// rest are deferred, and the model loads the tools it needs from them with
// tool_search.
export const TOOL_BUDGET_MIN_CHARS = 40_000
export const TOOL_BUDGET_MAX_CHARS = 160_000

// toolBudgetChars returns the budget for a model's context window in
// tokens; an unknown window gets the smallest.
export function toolBudgetChars(contextWindow) {
  const share = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow * 0.1 * 4) : 0
  return Math.min(TOOL_BUDGET_MAX_CHARS, Math.max(TOOL_BUDGET_MIN_CHARS, share))
}

function toolSize(tool) {
  return JSON.stringify({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? {} }).length
}

// deferredServers returns the slugs of the servers whose tools are deferred:
// the connectors, smallest first, from the first one that no longer fits in
// the budget. Exported for tests.
export function deferredServers(entries, budget = TOOL_BUDGET_MIN_CHARS) {
  const sized = entries
    .filter((e) => e.slug !== PLATFORM_SERVER && e.type !== 'stdio')
    .map((e) => ({ slug: e.slug, size: e.tools.reduce((n, t) => n + toolSize(t), 0) }))
    .sort((a, b) => a.size - b.size || a.slug.localeCompare(b.slug))
  const deferred = new Set()
  let used = 0
  for (const { slug, size } of sized) {
    if (deferred.size === 0 && used + size <= budget) used += size
    else deferred.add(slug)
  }
  return deferred
}

// The system prompt section that names the deferred servers, keyed like
// pi's own sections. pi's tool_search lists no servers, so without it the
// model would not know these tools exist; and a tool named in a skill, a
// memory or a trigger's prompt, called before it is loaded, comes back
// "not found".
export const DEFERRED_TOOLS_SECTION = 'zwrm_deferred_tools'
const SECTION_MAX_CHARS = 4096
const SERVER_SUMMARY_MAX_CHARS = 200
// A deferred server's tool names are listed when it has at most this many,
// so the model can load one by its exact name.
export const LISTED_TOOLS_MAX = 40

// deferredToolsSection renders that section for the deferred servers
// ({slug, tools, names?, instructions?}), or undefined when there are none.
// A server's tool names are dropped, then its whole line, as the section
// would outgrow its limit. Exported for tests.
export function deferredToolsSection(servers) {
  if (!servers?.length) return undefined
  const intro = 'To keep each request small, the tools of these connectors are not declared to you up front. ' +
    'Load the ones you need with `tool_search` before calling them: describe the action ' +
    '(for example "upload a file to OneDrive"), or give a tool\'s exact name with limit 1. ' +
    'A tool that has not been loaded yet answers "not found"; that does not mean it is missing. ' +
    'Loaded tools stay available for the rest of this chat.'
  const sorted = [...servers].sort((a, b) => a.slug.localeCompare(b.slug))
  const lines = []
  let size = intro.length
  for (const [i, s] of sorted.entries()) {
    let summary = (s.instructions ?? '').trim().split('\n', 1)[0].trim()
    if (summary.length > SERVER_SUMMARY_MAX_CHARS) summary = `${summary.slice(0, SERVER_SUMMARY_MAX_CHARS - 1).trimEnd()}…`
    const head = `- mcp__${s.slug} (${s.tools} tool${s.tools === 1 ? '' : 's'})${summary ? `: ${summary}` : ''}`
    const named = s.names?.length ? `${head}\n  ${s.names.join(', ')}` : head
    // Room for this line and, should a later one not fit, the closing line.
    const room = SECTION_MAX_CHARS - size - 80
    const line = named.length + 1 <= room ? named : head
    if (line.length + 1 > room) {
      lines.push(`- … ${sorted.length - i} more; find their tools with tool_search`)
      break
    }
    lines.push(line)
    size += line.length + 1
  }
  return [intro, ...lines].join('\n')
}

// buildBridgedTools connects every server and returns the pi ToolDefinitions
// for all their tools, those of the deferred servers marked deferred, and
// the deferred servers themselves ({slug, tools, names?, instructions?}).
// opts.toolBudgetChars is the budget (toolBudgetChars of the session's
// model). Per-server failures are logged and skipped; the returned closer
// tears the clients down at session end.
export async function buildBridgedTools(servers, log, opts = {}) {
  const { entries, close } = await connectServers(servers, log, opts)
  const deferred = deferredServers(entries, opts.toolBudgetChars)
  const tools = []
  for (const e of entries) {
    const defer = deferred.has(e.slug)
    for (const t of e.tools) tools.push(toolDefinitionFor(e.slug, t, e.call, defer ? { deferred: true } : {}))
  }
  const deferredList = entries
    .filter((e) => deferred.has(e.slug))
    .map((e) => ({
      slug: e.slug,
      tools: e.tools.length,
      ...(e.tools.length <= LISTED_TOOLS_MAX ? { names: e.tools.map((t) => `mcp__${e.slug}__${t.name}`) } : {}),
      ...(e.instructions ? { instructions: e.instructions } : {}),
    }))
  if (deferredList.length > 0) {
    log(`mcp bridge: deferred behind tool_search: ${deferredList.map((d) => `${d.slug} (${d.tools})`).join(', ')}`)
  }
  return { tools, close, deferred: deferredList }
}

// connectServers is the harness-neutral half of the bridge: it connects every
// server, lists its tools, and returns one entry per server carrying the raw
// MCP tool listings plus a `call(toolName, args, signal)` with the reconnect
// and side-effect-safety rules above. Each harness renders those listings into
// its own tool shape — pi ToolDefinitions here, codex DynamicToolSpecs in
// codex-tools.mjs — so the transport, failure, and retry semantics stay in one
// place and cannot drift between harnesses. opts.cwd / opts.env are the
// session cwd and env stdio servers start with.
export async function connectServers(servers, log, opts = {}) {
  const entries = []
  const clients = new Map() // slug -> {client, cfg, reconnecting}
  let closed = false

  const callOn = (entry, toolName, args, signal) =>
    entry.client.callTool({ name: toolName, arguments: args || {} }, undefined, { signal })

  // Per-server budget for connect + list: the daemon's create handler runs
  // inline under the CP's 15s HTTP timeout, and a blackholed endpoint must
  // degrade (skip the server) rather than stall session creation. The loser
  // of the race is defused (no unhandled rejection) and a late-completing
  // connect closes its own client instead of leaking it. A stdio server
  // shares the budget, which is why image servers must be baked into the
  // image rather than fetched on first spawn (image-mcp.mjs).
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
      client = await setupWithTimeout(() => connectServer(slug, cfg, opts), `connect ${slug}`,
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
              const fresh = await connectServer(slug, entry.cfg, opts)
              // close() may have run while we reconnected: it saw the dead
              // client, so reap the fresh one (a live stdio child) here.
              if (closed) { try { fresh?.close?.() } catch {} ; return }
              entry.client = fresh
            })().finally(() => { entry.reconnecting = null })
          }
          await entry.reconnecting
          if (closed || signal?.aborted) throw err
          return await callOn(entry, toolName, args, signal)
        }
      }

      const instructions = client.getInstructions?.()
      entries.push({ slug, type: cfg.type, tools: listed.tools || [], call, ...(typeof instructions === 'string' && instructions.trim() ? { instructions } : {}) })
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
    // Resolves once every client has closed (a stdio server's process
    // gone), or after BRIDGE_CLOSE_MS: a harness retired for a set-up change
    // (#2004) waits for it, so its successor never starts the same image
    // servers beside them (a browser's profile lock). Others ignore it.
    close() {
      closed = true
      const closing = []
      for (const { client } of clients.values()) {
        try { closing.push(Promise.resolve(client.close?.()).catch(() => {})) } catch {}
      }
      clients.clear()
      let timer
      const late = new Promise((resolve) => { timer = setTimeout(resolve, BRIDGE_CLOSE_MS) })
      return Promise.race([Promise.all(closing), late]).finally(() => clearTimeout(timer))
    },
  }
}

// searchLoadedToolNames returns the tools tool_search loaded in a pi
// session's branch (its results' details.loaded), which compaction keeps.
// pi records the declared tools in the transcript but restores them only
// when navigating the session tree, not when a session is opened from its
// file, so the driver brings back what a resumed session had loaded. Only
// what tool_search loaded: a chat from before a server was deferred
// declared all of its tools, and must not get them back. Exported for
// tests.
export function searchLoadedToolNames(entries, toolSearchName = 'tool_search') {
  const names = new Set()
  for (const e of entries ?? []) {
    const m = e?.type === 'message' ? e.message : undefined
    if (m?.role !== 'toolResult' || m.toolName !== toolSearchName || m.isError) continue
    for (const name of Array.isArray(m.details?.loaded) ? m.details.loaded : []) {
      if (typeof name === 'string') names.add(name)
    }
  }
  return [...names]
}
