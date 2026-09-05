import { SLEEP_DESCRIPTION, SLEEP_UNTIL_DESCRIPTION, sleepInputSchema, sleepUntilInputSchema, runSleep, runSleepUntil, mapOutcome } from './run-tools.mjs'

// Codex dynamic-tool layer (#1090): renders the session's tools as codex
// `DynamicToolSpec`s and dispatches the `item/tool/call` server requests they
// produce.
//
// WHY A BRIDGE AND NOT CODEX'S NATIVE MCP CLIENT: codex emits no approval
// request for its own MCP tool calls, so connectors wired through
// `[mcp_servers]` would run OUTSIDE the platform permission gate — escalation
// (#731) would go dark on this harness alone. A dynamic tool is executed by
// THIS daemon, which puts every call back through the same gate the claude and
// pi harnesses use.
//
// WHY THE NAMES DIFFER FROM EVERY OTHER HARNESS: codex RESERVES the `mcp__`
// prefix. Declaring `mcp__github__create_issue` is rejected outright —
// "dynamic tool name is reserved" — and so is a namespace of that shape
// (verified against the pinned 0.145.0). So the wire name the model sees is
// `zwrm__<slug>__<tool>`, and the driver canonicalizes it back to
// `mcp__<slug>__<tool>` before anything platform-side sees it: the escalation
// gate matches the canonical name, and so does the transcript, so a codex run
// reads identically to a claude or pi one.
//
// This module deliberately does NOT import the MCP SDK — the naming and
// dispatch rules above are the load-bearing part, and keeping them free of
// node_modules is what lets them be tested.

// The prefix codex accepts in place of the reserved `mcp__`.
export const CODEX_TOOL_PREFIX = 'zwrm__'

// codexToolName renders the wire name for one bridged connector tool.
export function codexToolName(slug, tool) {
  return `${CODEX_TOOL_PREFIX}${slug}__${tool}`
}

// canonicalToolName maps a wire name back to the platform's canonical
// `mcp__<slug>__<tool>`. Everything platform-side — the escalation gate
// (isEscalatedTool), the emitted transcript, the run policy — speaks that
// name on every harness; only the codex wire differs.
export function canonicalToolName(wireName) {
  const name = String(wireName || '')
  if (!name.startsWith(CODEX_TOOL_PREFIX)) return name
  return `mcp__${name.slice(CODEX_TOOL_PREFIX.length)}`
}

// codexToolSpec renders one MCP tool listing as a codex DynamicToolFunctionSpec.
// The MCP inputSchema is plain JSON Schema and passes through unchanged.
export function codexToolSpec(slug, tool) {
  return {
    type: 'function',
    name: codexToolName(slug, tool.name),
    description: tool.description || `${tool.name} (via ${slug})`,
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  }
}

// toolCallResponse renders a DynamicToolCallResponse. Codex takes content as
// typed items, so text is wrapped rather than concatenated.
export function toolCallResponse(text, success = true) {
  return { contentItems: [{ type: 'inputText', text: String(text ?? '') }], success }
}

// mcpResultToCodex flattens an MCP tools/call result into a codex tool
// response. Images become a data URL, matching how the pi bridge keeps them
// addressable; other block types are dropped (no platform tool emits them).
export function mcpResultToCodex(result) {
  const items = []
  for (const c of result?.content || []) {
    if (!c || typeof c !== 'object') continue
    if (c.type === 'text' && typeof c.text === 'string') {
      items.push({ type: 'inputText', text: c.text })
    } else if (c.type === 'image' && typeof c.data === 'string') {
      items.push({ type: 'inputImage', imageUrl: `data:${c.mimeType || 'image/png'};base64,${c.data}` })
    }
  }
  if (items.length === 0) items.push({ type: 'inputText', text: '' })
  // isError is the MCP-level "the tool failed" flag; success=false is how the
  // model is told, and it must not be conflated with a transport failure.
  return { contentItems: items, success: !result?.isError }
}

// connectorFingerprint identifies the CONNECTOR set a thread was created with.
//
// Codex accepts dynamicTools only on thread/start — not on resume, not per
// turn, and no method updates a live thread — but it PERSISTS them and serves
// them again on resume (verified against the real API: a resumed thread called
// a tool it could not have re-declared). So a resumed thread always runs the
// set frozen when it was created, and resuming after the agent's connectors
// changed would run the wrong toolset for the rest of that conversation.
//
// It fingerprints the configured connector SLUGS, deliberately, not the
// discovered tool list:
//   - the run tools are NOT connectors and differ by session kind (a run
//     declares sleep/sleep_until, a chat declares none). Including them would
//     make chat and runs on the same workspace disagree forever, so every
//     alternation between them would throw the conversation away — which is
//     the normal usage pattern, not an edge case;
//   - a connector that is momentarily unreachable is skipped by the bridge
//     (connect/list is time-budgeted). Fingerprinting discovered tools would
//     let one slow gateway destroy a live conversation, then record the
//     degraded set and destroy the next one too.
// The slug set is known before any network call and is identical for chat and
// runs, so it changes only when the agent's configuration actually changes.
//
// The trade-off is deliberate: a connector that ADDS a tool upstream will not
// be noticed until a fresh thread starts, so the model runs without the new
// tool for the rest of that conversation. That is a graceful, recoverable
// degradation; discarding conversations is not.
export function connectorFingerprint(mcpServers) {
  return Object.keys(mcpServers || {}).sort().join(',')
}

// buildCodexRunTools renders the platform run tools (#803) as dynamic tools:
// the same semantics and model-facing text as the claude driver's in-process
// `platform` MCP server and pi's native ones, dispatched through the shared
// run-tools module (#1493) so validation is identical. Unattended runs only —
// an interactive session has a human on the stream.
export function buildCodexRunTools(s, h) {
  return [
    {
      spec: {
        type: 'function',
        name: 'zwrm__platform__sleep',
        description: SLEEP_DESCRIPTION(h.MAX_SLEEP_SECONDS),
        inputSchema: sleepInputSchema(h.MAX_SLEEP_SECONDS),
      },
      run: (args) => codexOutcome(runSleep(s, h, args)),
    },
    {
      spec: {
        type: 'function',
        name: 'zwrm__platform__sleep_until',
        description: SLEEP_UNTIL_DESCRIPTION(h.MAX_SLEEP_SECONDS),
        inputSchema: sleepUntilInputSchema(),
      },
      run: (args) => codexOutcome(runSleepUntil(s, h, args)),
    },
  ]
}

// codexOutcome maps a run-tools outcome onto codex's envelope: a rejection
// is thrown (codex reports a failed dynamic tool call), text becomes a
// successful tool response, and a park result goes through the same MCP
// result converter every other tool uses.
async function codexOutcome(pending) {
  return mapOutcome(await pending, {
    error: (o) => { throw new Error(o.error) },
    text: (text) => toolCallResponse(text),
    park: (result) => mcpResultToCodex(result),
  })
}
