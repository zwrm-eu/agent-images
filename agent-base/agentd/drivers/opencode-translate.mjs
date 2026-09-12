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
//  - the `question` tool (#1555) is NOT a permission: it raises
//    `question.asked` {id, sessionID, questions:[{question, header, options:
//    [{label, description}], multiple?, custom?}], tool:{messageID, callID}}
//    and blocks until POST /question/:id/reply {answers: string[][]} (one
//    label array per question, in order) or POST /question/:id/reject, which
//    fails the tool call with "The user dismissed this question" and lets the
//    turn continue. Source: packages/opencode/src/question at the pinned tag.

import { RUN_TOOL_NAMES } from './opencode-run-tools.mjs'

// OPENCODE_PROVIDER_ID is the provider key the platform's seeded opencode
// config uses for the gateway (#1392). The driver names it on every prompt;
// the Go config renderer must emit the same key.
export const OPENCODE_PROVIDER_ID = 'zwrm'

// Ceiling on an MCP tool call's result (#1388). OpenCode otherwise waits
// FOREVER for a result: when a connector's upstream MCP SSE stream dies after
// a tools/call is accepted, the result is never delivered nor errored, and the
// whole session wedges in `working` (the production hang — a gojiberry
// connector whose upstream SSE "exceeded 5 retries without progress"). With
// this set, a dead call terminates as an MCP timeout error the model can react
// to, and the turn completes. Generous (2m) so a legitimately slow connector
// tool is not falsely cut off; the park channel (sleep/sleep_until) is a baked
// FILE tool, not MCP, so it is unaffected, and connector escalation is a
// permission pause before the call, not an in-flight MCP request.
export const MCP_TOOL_TIMEOUT_MS = 120_000

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

// questionInputFor renders a `question.asked` request as the platform's
// permission.request `input` (#1555): {questions: [{id, question, header,
// options: [{label, description}], multiSelect}]} — the shape the dashboard's
// question card and the codex twin already speak. OpenCode questions carry
// no id, so one is assigned by position (q1, q2, …); answers come back keyed
// by it (see questionAnswersFor). OpenCode's `custom` flag is not forwarded:
// no platform consumer honours it (the dashboard always offers free text).
export function questionInputFor(req) {
  const questions = Array.isArray(req?.questions) ? req.questions : []
  return {
    questions: questions.map((q, i) => ({
      id: `q${i + 1}`,
      question: typeof q?.question === 'string' ? q.question : '',
      header: typeof q?.header === 'string' ? q.header : '',
      options: (Array.isArray(q?.options) ? q.options : [])
        // An empty label would make the dashboard card demote the whole
        // request to a plain approval (whose Allow carries no answers).
        .filter((o) => o && typeof o === 'object' && typeof o.label === 'string' && o.label !== '')
        .map((o) => ({ label: o.label, ...(typeof o.description === 'string' ? { description: o.description } : {}) })),
      multiSelect: q?.multiple === true,
    })),
  }
}

// questionAnswersFor maps the platform answer object (updated_input.answers)
// back onto OpenCode's reply shape: one string array per question, in
// question order. The platform contract keys answers by question id; the
// question text is accepted too, so a client written against claude (whose
// AskUserQuestion answers are keyed by text) works unchanged. A value is a
// string array, or a string: the dashboard joins a multi-select into one
// ", "-separated string (claude's answer contract), so a string that is not
// itself an option label but splits into option labels is unjoined back into
// them; anything else is one free-text answer. A question nobody answered
// maps to [] — OpenCode renders that as "Unanswered", which is honest.
// Returns null when `answers` is not an object at all: an approval that
// carries no answers is not an answer, and the caller rejects the question
// rather than fabricate one.
export function questionAnswersFor(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null
  return (Array.isArray(questions) ? questions : []).map((q) => {
    const raw = answers[q?.id] ?? answers[q?.question]
    if (Array.isArray(raw)) return raw.filter((a) => typeof a === 'string' && a !== '')
    if (typeof raw !== 'string' || raw === '') return []
    const labels = new Set((q?.options || []).map((o) => o?.label))
    if (labels.has(raw)) return [raw]
    const parts = raw.split(', ')
    if (parts.length > 1 && parts.every((p) => labels.has(p))) return parts
    return [raw]
  })
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
export function buildSessionConfig({ platform, mcpServers, interactive, instructionsPath, models, catalogLive }) {
  const cfg = { ...(platform && typeof platform === 'object' ? platform : {}) }

  // Live external-provider models (#1446). The boot seed is written once per
  // boot and a snapshot wake never re-runs it, so a provider registered after
  // the VM booted is unknown to opencode until the next boot — and one
  // REMOVED after boot lingers. The CP renders the org's CURRENT ext/ catalog
  // into the spec per session (in the seed's own model-entry shape) and, when
  // its listing succeeded, marks it live (authoritative, even when empty): the
  // seeded ext/ entries are then dropped and the live set takes their place.
  // Without the flag (a listing failure, or a CP predating it) the seed is
  // kept and any sent models only add — never strip on data the CP could not
  // read. All on a fresh copy, never mutating the shared platform object; ext/
  // keys can't collide with catalog slugs (the namespace is reserved). Skipped
  // when the seed has no provider to merge into: an entry without the
  // provider's baseURL/token would be unreachable anyway.
  const live = models && typeof models === 'object' && !Array.isArray(models) ? models : {}
  if (catalogLive || Object.keys(live).length > 0) {
    const providers = cfg.provider && typeof cfg.provider === 'object' ? cfg.provider : null
    const seeded = providers?.[OPENCODE_PROVIDER_ID]
    if (seeded && typeof seeded === 'object') {
      const seededModels = seeded.models && typeof seeded.models === 'object' ? seeded.models : {}
      const base = catalogLive
        ? Object.fromEntries(Object.entries(seededModels).filter(([slug]) => !slug.startsWith('ext/')))
        : { ...seededModels }
      cfg.provider = {
        ...providers,
        [OPENCODE_PROVIDER_ID]: { ...seeded, models: { ...base, ...live } },
      }
    }
  }

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
  // The question tool (#1555) rides the platform permission channel: the
  // driver turns `question.asked` into a permission.request {kind: question}
  // and answers over the native reply route. Interactive sessions have a
  // human on the stream to answer; an unattended run has nobody, so the tool
  // stays off there and the model cannot park a turn on a question nobody
  // sees (the claude disallowedTools / codex refusal rule). Config-level deliberately
  // (probed): unlike a per-prompt tools override, it also covers
  // command-invoked turns (#1429), whose endpoint has no tools field.
  //
  // task (subagent spawn) is LEFT ENABLED: the #1388 session hang was pinned
  // (deterministic repro) to a connector MCP call that never returns when its
  // upstream dies — NOT the subagent, which was only incidental. The real fix
  // is the MCP timeout below, so task no longer needs disabling.
  cfg.tools = { ...(cfg.tools || {}), question: !!interactive }
  // Bound every MCP call so a dead connector upstream can't wedge the session
  // (#1388) — see MCP_TOOL_TIMEOUT_MS.
  cfg.experimental = { ...(cfg.experimental || {}), mcp_timeout: MCP_TOOL_TIMEOUT_MS }
  if (instructionsPath) {
    cfg.instructions = [...(Array.isArray(cfg.instructions) ? cfg.instructions : []), instructionsPath]
  }
  return cfg
}
