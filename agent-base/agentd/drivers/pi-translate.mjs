// Pure translators from pi SDK shapes to the claude-stream-json-shaped
// payloads the platform's event contract is built on (#1063). Kept free of
// I/O and pi imports so `node --test` covers them without an API key.
//
// Load-bearing consumers of these shapes (do not change without reading them):
//  - applyEventMeta (api/handlers/agent_sessions.go): sdk.system init
//    .session_id = resume handle; sdk.result .total_cost_usd (CUMULATIVE per
//    session row) + .result (run summary); sdk.result presence = run
//    completion gate.
//  - dashboard agentTranscript.ts: assistant/user content blocks;
//    partialTextDelta reads payload.event.content_block_delta.delta.text_delta.

// initPayload synthesizes the claude `system/init` message for a pi session.
// session_id carries the pi session FILE PATH — the durable resume handle
// (SessionManager.open takes a path; the file lives on the workspace volume).
export function initPayload(sessionFile, model) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionFile || '',
    model: model || '',
    harness: 'pi',
  }
}

// contentBlocks maps pi-ai AssistantMessage content (TextContent |
// ThinkingContent | ToolCall) to claude message content blocks.
export function contentBlocks(content) {
  const blocks = []
  for (const c of content || []) {
    if (!c || typeof c !== 'object') continue
    switch (c.type) {
      case 'text':
        blocks.push({ type: 'text', text: c.text ?? '' })
        break
      case 'thinking':
        blocks.push({ type: 'thinking', thinking: c.thinking ?? c.text ?? '' })
        break
      case 'toolCall':
        // pi-ai ToolCall: {type:'toolCall', id, name, arguments}
        blocks.push({
          type: 'tool_use',
          id: c.id ?? '',
          name: c.name ?? '',
          input: c.arguments ?? {},
        })
        break
      default:
        // Unknown block types are dropped rather than crashing the stream;
        // the durable pi entry still has them if ever needed.
    }
  }
  return blocks
}

// usagePayload maps pi-ai Usage (per-message or session-cumulative token
// counts) to the claude usage field names the dashboard/CP read.
export function usagePayload(u) {
  if (!u || typeof u !== 'object') return undefined
  return {
    input_tokens: u.input ?? 0,
    output_tokens: u.output ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
    cache_creation_input_tokens: u.cacheWrite ?? 0,
  }
}

// assistantPayload maps a completed pi assistant message (message_end) to the
// claude `assistant` stream-json shape.
export function assistantPayload(msg) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: contentBlocks(msg?.content),
      model: msg?.model ?? '',
      ...(msg?.usage ? { usage: usagePayload(msg.usage) } : {}),
      ...(msg?.stopReason ? { stop_reason: msg.stopReason } : {}),
    },
  }
}

// toolResultText flattens a pi ToolResultMessage's content to text for the
// claude tool_result block. Pi tool results carry (text|image)[] output plus
// optional details; text is what the transcript renders.
export function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
}

// toolResultsPayload maps a pi turn's tool results to the claude `user`
// message that carries tool_result blocks.
export function toolResultsPayload(toolResults) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: (toolResults || []).map((r) => ({
        type: 'tool_result',
        tool_use_id: r?.toolCallId ?? '',
        content: toolResultText(r?.content ?? r?.output),
        ...(r?.isError ? { is_error: true } : {}),
      })),
    },
  }
}

// partialPayload maps a pi text_delta streaming event to the claude
// stream_event shape partialTextDelta() reads. Returns null for deltas the
// live draft doesn't render (thinking, tool args, start/end markers).
export function partialPayload(assistantMessageEvent) {
  const ev = assistantMessageEvent
  if (!ev || ev.type !== 'text_delta' || typeof ev.delta !== 'string' || ev.delta === '') return null
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: ev.delta },
    },
  }
}

// sumAssistantUsage totals the token usage across a cycle's assistant
// messages (agent_end order), approximating claude's per-turn result usage.
// Returns null when no message carries usage (caller falls back to
// session-cumulative stats).
export function sumAssistantUsage(messages) {
  let found = false
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const m of messages || []) {
    if (m?.role !== 'assistant' || !m.usage) continue
    found = true
    total.input += m.usage.input ?? 0
    total.output += m.usage.output ?? 0
    total.cacheRead += m.usage.cacheRead ?? 0
    total.cacheWrite += m.usage.cacheWrite ?? 0
  }
  return found ? total : null
}

// lastAssistantText extracts the final assistant text from a list of pi
// messages (agent_end order) — the run-summary `result` field.
export function lastAssistantText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant') continue
    const texts = (m.content || []).filter((c) => c?.type === 'text' && c.text).map((c) => c.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

// resultPayload builds the claude `result` message for a settled pi prompt
// cycle. costUSD MUST be the session-row-cumulative cost (stats.cost minus
// the resume baseline): the CP banks GREATEST-diff deltas per result
// (AccrueAgentSessionCost), so emitting per-turn deltas would under-bill and
// emitting file-lifetime totals after a resume would double-bill.
export function resultPayload({ subtype = 'success', resultText = '', costUSD = 0, usage, numTurns = 1, durationMS = 0 }) {
  return {
    type: 'result',
    subtype,
    result: resultText,
    ...(subtype !== 'success' ? { is_error: true } : {}),
    total_cost_usd: costUSD,
    num_turns: numTurns,
    duration_ms: durationMS,
    ...(usage ? { usage: usagePayload(usage) } : {}),
  }
}

// classifyPiError mirrors claude's classifyRunError for in-process pi SDK
// failures: no subprocess signals here — the taxonomy is API-shaped.
//
// provider is the vendor that owns the requested model (#1149); it is named in
// the message because the catalog is multi-vendor and a diagnosis that points at
// the wrong vendor outlives the outage. Omitted (undefined) keeps the message
// generic rather than guessing.
//
// Since #1193 every request goes to the platform gateway, so a 401 is the
// SESSION credential being rejected — an expired or revoked inference token, not
// a vendor key (the VM holds none). Restarting the session mints a fresh one,
// which is what the message asks for.
export function classifyPiError(err, provider) {
  const raw = String(err?.stack || err?.message || err)
  const shortMsg = String(err?.message || err)
  const modelHint = provider ? ` (model served by ${String(provider)})` : ''
  if (/401|invalid.*api.*key|authentication/i.test(raw)) {
    return {
      cause: 'auth',
      message: `Model gateway authentication failed — this session's platform token was rejected${modelHint}. Start a new session to mint a fresh one; if it persists, contact support.`,
      detail: raw,
    }
  }
  if (/429|rate.?limit|overloaded/i.test(raw)) {
    return {
      cause: 'rate_limited',
      message: 'The model API rate-limited the session. Retry shortly.',
      detail: raw,
    }
  }
  if (/insufficient.*credit|billing|payment/i.test(raw)) {
    return {
      cause: 'billing',
      message: provider
        ? `The model API rejected the request for billing reasons — check the ${provider} account balance.`
        : 'The model API rejected the request for billing reasons — check the model provider account balance.',
      detail: raw,
    }
  }
  return { cause: 'error', message: shortMsg, detail: raw }
}

// mapEffort maps the platform effort enum onto pi thinking levels. The names
// coincide by design; pi additionally clamps per model (e.g. opus-4-8 maps
// only xhigh/max explicitly and uses adaptive thinking otherwise).
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export function mapEffort(effort) {
  return EFFORTS.has(effort) ? effort : undefined
}
