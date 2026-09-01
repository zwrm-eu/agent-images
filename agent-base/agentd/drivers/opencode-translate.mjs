// Pure translators from OpenCode server shapes (v1 HTTP + SSE, probed against
// the pinned binary — see the Dockerfile pin) to the claude-stream-json-shaped
// payloads the platform's event contract is built on (#1391). Kept free of
// I/O and child-process imports so `node --test` covers them without a
// binary or a model key.
//
// Load-bearing consumers of these shapes (do not change without reading them):
//  - applyEventMeta (api/handlers/agent_sessions.go): sdk.system init
//    .session_id = resume handle; sdk.result .total_cost_usd (CUMULATIVE per
//    session row) + .result (run summary); sdk.result presence = run
//    completion gate.
//  - dashboard agentTranscript.ts: assistant/user content blocks;
//    partialTextDelta reads payload.event.content_block_delta.delta.text_delta.
//
// Probed wire facts this module is written against (1.18.25):
//  - the ask event is `permission.asked` (docs say permission.updated; the
//    binary disagrees), carrying {id, sessionID, permission, patterns,
//    metadata, always, tool:{messageID, callID}};
//  - a tool is ONE part whose state mutates pending → running →
//    completed|error — tool_use is emitted on the first running sighting and
//    tool_result on the terminal state;
//  - a rejected ask ends the turn server-side with the tool part in state
//    error ("The user rejected permission..."); the reply body's message
//    field is ignored by the v1 route, so denial text does NOT reach the
//    model — unlike claude/pi/codex. Documented, not worked around.

import { RUN_TOOL_NAMES } from './opencode-run-tools.mjs'

// OPENCODE_PROVIDER_ID is the provider key the platform's seeded opencode
// config uses for the gateway (#1392). The driver names it on every prompt;
// the Go config renderer must emit the same key.
export const OPENCODE_PROVIDER_ID = 'zwrm'

// initPayload synthesizes the claude `system/init` message. session_id
// carries the OpenCode session id — the durable resume handle (sessions live
// in ~/.local/share/opencode/opencode.db on the workspace volume, so resume
// survives VM destroy).
export function initPayload(sessionId, model) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId || '',
    model: model || '',
    harness: 'opencode',
  }
}

// partialPayload maps a text-part delta to the claude stream_event shape
// partialTextDelta() reads. Returns null for empty deltas.
export function partialPayload(delta) {
  if (typeof delta !== 'string' || delta === '') return null
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: delta },
    },
  }
}

// textPayload maps a finished text part to the claude assistant shape.
export function textPayload(text, model) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: text ?? '' }], model: model || '' },
  }
}

// reasoningPayload maps a reasoning part to a claude thinking block.
export function reasoningPayload(text, model) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: text ?? '' }], model: model || '' },
  }
}

// toolUsePayload maps a tool part's first running sighting to the claude
// `assistant` message carrying a tool_use block. The callID is the block id:
// the matching tool_result must carry the same id or the dashboard renders an
// orphaned call.
export function toolUsePayload(part, model) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: part?.callID ?? '',
        name: part?.tool ?? '',
        input: part?.state?.input ?? {},
      }],
      model: model || '',
    },
  }
}

// toolResultText renders a terminal tool state's output.
export function toolResultText(state) {
  if (!state || typeof state !== 'object') return ''
  if (state.status === 'error') return String(state.error ?? '')
  return typeof state.output === 'string' ? state.output : ''
}

// toolResultPayload maps a tool part's terminal state to the claude `user`
// message carrying a tool_result block.
export function toolResultPayload(part) {
  const state = part?.state ?? {}
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: part?.callID ?? '',
        content: toolResultText(state),
        ...(state.status === 'error' ? { is_error: true } : {}),
      }],
    },
  }
}

// usagePayload maps OpenCode's token breakdown to the claude usage field
// names the dashboard/CP read. OpenCode reports cache reads and writes
// separately, like claude.
export function usagePayload(tokens) {
  if (!tokens || typeof tokens !== 'object') return undefined
  return {
    input_tokens: tokens.input ?? 0,
    output_tokens: tokens.output ?? 0,
    cache_read_input_tokens: tokens.cache?.read ?? 0,
    cache_creation_input_tokens: tokens.cache?.write ?? 0,
  }
}

// resultPayload builds the claude `result` message for a completed turn.
//
// costUSD is CUMULATIVE for the PLATFORM session: the caller reads OpenCode's
// session-cumulative cost and subtracts the baseline captured at resume, so a
// workspace resumed across platform sessions does not re-report spend a
// previous session already reported (the pi open-baseline rule). The gateway
// meters the authoritative charge either way (#1193) — these numbers drive
// the transcript display, not billing.
export function resultPayload({ subtype = 'success', resultText = '', costUSD = 0, tokens, numTurns = 1, durationMS = 0 }) {
  return {
    type: 'result',
    subtype,
    result: resultText,
    ...(subtype !== 'success' ? { is_error: true } : {}),
    total_cost_usd: costUSD,
    num_turns: numTurns,
    duration_ms: durationMS,
    ...(tokens ? { usage: usagePayload(tokens) } : {}),
  }
}

// gateInputFor renders the platform permission request's `input` — what a
// reviewer sees in the approval prompt — from a permission.asked event. The
// metadata carries the concrete action (bash: {command}); patterns name what
// an "always" grant would cover, which the platform does not use but a
// reviewer may still want to see.
export function gateInputFor(ask) {
  return {
    ...(ask?.metadata && typeof ask.metadata === 'object' ? ask.metadata : {}),
    ...(Array.isArray(ask?.patterns) && ask.patterns.length > 0 ? { patterns: ask.patterns } : {}),
  }
}

// classifyOpenCodeError mirrors claude's classifyRunError. OpenCode surfaces
// errors as {name, data} objects on session.error / message info.error, plus
// process- and HTTP-shaped failures from the client.
export function classifyOpenCodeError(err) {
  const raw = String(err?.stack || err?.message || err)
  const name = String(err?.name || err?.data?.name || '')
  const shortMsg = String(err?.message || err?.data?.message || err)
  if (/401|unauthorized|invalid.*key|authentication/i.test(raw)) {
    return {
      cause: 'auth',
      message: 'The model gateway rejected the session credential. Reconnect the workspace to mint a fresh one.',
      detail: raw,
    }
  }
  if (/429|rate.?limit|overloaded|quota/i.test(raw)) {
    return { cause: 'rate_limited', message: 'The model gateway rate-limited the session. Retry shortly.', detail: raw }
  }
  if (name === 'MessageAbortedError' || /aborted/i.test(name)) {
    return { cause: 'error', message: 'The turn was aborted.', detail: raw }
  }
  if (/exited|spawn|ECONNREFUSED|socket hang up/i.test(raw)) {
    return { cause: 'crashed', message: 'The opencode server exited unexpectedly.', detail: raw }
  }
  return { cause: 'error', message: shortMsg, detail: raw }
}

// Reserved MCP server slug: the platform session server (save_skill /
// save_memory). Its absence is survivable — the #1063 precedent — so the
// pre-#1392 stopgap ignores it rather than refusing the session.
export function isReservedMCPServer(slug) {
  return slug === 'zwrm'
}

// ---- #1392: native-MCP connectors, session config, canonical names ----------

// canonicalOpenCodeToolName maps OpenCode's MCP wire name (`<slug>_<tool>`)
// back to the platform's canonical `mcp__<slug>__<tool>` — the name the
// escalation gate (isEscalatedTool), the run policy, and the transcript speak
// on every harness. slugs are the session's configured MCP server names;
// matching prefers the LONGEST one, because a slug may itself contain the
// underscore separator. Non-MCP names (native tools, run tools) pass through.
export function canonicalOpenCodeToolName(wireName, slugs) {
  const name = String(wireName || '')
  // The platform run tools' wire names ARE their canonical names; a
  // connector slugged 'sleep' must not rewrite 'sleep_until' into
  // mcp__sleep__until (review).
  if (RUN_TOOL_NAMES.includes(name)) return name
  let best = ''
  for (const slug of slugs || []) {
    if (name.length > slug.length + 1 && name.startsWith(slug + '_') && slug.length > best.length) {
      best = slug
    }
  }
  if (!best) return name
  return `mcp__${best}__${name.slice(best.length + 1)}`
}

// The native tools gated in Ask mode (and auto-answered by the driver in
// bypass): the mutating/network set, matching what the other harnesses
// prompt for. Reads (read/glob/grep/skill/todo) stay on OpenCode's allow
// defaults; doom_loop/external_directory keep their default 'ask' and ride
// the same gate.
export const GATED_PERMISSIONS = { bash: 'ask', edit: 'ask', webfetch: 'ask', websearch: 'ask' }

// buildSessionConfig merges the platform config (from
// /etc/opencode/opencode.json, rendered by build.OpenCodeConfigJSON) with the
// per-session pieces, producing the object the driver hands to `opencode
// serve` via OPENCODE_CONFIG_CONTENT:
//
//  - mcp: the session's connector servers PLUS the reserved zwrm platform
//    server, as native remote MCP entries. Unlike codex, OpenCode's own MCP
//    client DOES raise permission asks when the permission table names the
//    tool (probed on the pinned binary), so the native client keeps every
//    call inside the platform gate — no bridge process.
//  - permission: the gated native set, plus `<slug>_*: ask` for every MCP
//    server so connector calls surface to the gate in Ask mode and to the
//    escalation policy on runs — and run tools 'allow' (platform tools are
//    never gated, matching every other harness).
//  - instructions: the session's append_system_prompt (platform
//    instructions + memory + run preamble), delivered as a file path because
//    OpenCode's `instructions` APPEND to the system prompt — the codex
//    developerInstructions rule: add, never replace.
//
// KNOWN LIMIT (documented on #1392): the gateway-token refresh endpoint
// (#1363) rewrites spec.env and the MCP header objects in place, which the
// mcp-bridge picks up BY REFERENCE — but this config is serialized into the
// child's environment at spawn, so a refresh does not reach a LIVE opencode
// child; its MCP bearers age until the next session.
export function buildSessionConfig({ platform, mcpServers, interactive, instructionsPath }) {
  const cfg = { ...(platform && typeof platform === 'object' ? platform : {}) }

  const mcp = {}
  const permission = { ...GATED_PERMISSIONS }
  for (const [slug, server] of Object.entries(mcpServers || {})) {
    if (!server || server.type !== 'http' || !server.url) continue
    mcp[slug] = {
      type: 'remote',
      url: server.url,
      ...(server.headers && typeof server.headers === 'object' ? { headers: server.headers } : {}),
      enabled: true,
    }
    permission[`${slug}_*`] = 'ask'
  }
  if (Object.keys(mcp).length > 0) cfg.mcp = { ...(cfg.mcp || {}), ...mcp }
  if (!interactive) {
    permission.sleep = 'allow'
    permission.sleep_until = 'allow'
  }
  cfg.permission = { ...(cfg.permission || {}), ...permission }
  // The question tool has no answer channel on this platform's surfaces yet;
  // without this the model can park a turn on a question nobody sees.
  // Config-level deliberately (probed): unlike a per-prompt tools override,
  // it also covers command-invoked turns (#1429), whose endpoint has no
  // tools field.
  cfg.tools = { ...(cfg.tools || {}), question: false }
  if (instructionsPath) {
    cfg.instructions = [...(Array.isArray(cfg.instructions) ? cfg.instructions : []), instructionsPath]
  }
  return cfg
}
