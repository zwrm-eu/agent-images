import { hasAnswers } from './drivers/questions.mjs'

// decisionForRequest drops updated_input from a decision on a request whose
// permission.request event did not reach the timeline whole (#1631): the
// client saw a truncated copy of the input, and an approval echoing it back
// would run the truncated input. The approval then runs the input the harness
// asked about. A question keeps updated_input: its answers ride there, and
// every driver reads only the answers from it.
export function decisionForRequest(pending, body, inputTruncated) {
  if (!inputTruncated || pending.kind === 'question' || body.updated_input == null) return body
  const { updated_input: _ignored, ...rest } = body
  return rest
}

export function permissionDecisionPayload(requestId, body) {
  return {
    request_id: requestId,
    behavior: body.behavior,
    ...(body.message ? { message: body.message } : {}),
    ...(body.updated_input != null ? { updated_input: body.updated_input } : {}),
    ...(hasAnswers(body.updated_input?.answers) ? { answers: body.updated_input.answers } : {}),
  }
}

// contextUsagePayload is the context.usage event (#1553): how much of the
// model's context window the conversation occupies after a turn, from what
// the harness measures. `window` is omitted where the harness does not know
// it (opencode); the control plane fills it from its catalog. The
// percentage is the reader's to derive, so the two delivery paths (stream
// and GET) cannot disagree on it.
export function contextUsagePayload(tokens, window) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null
  const known = Number.isFinite(window) && window > 0
  return { tokens: Math.round(tokens), ...(known ? { window: Math.round(window) } : {}) }
}

// contextTokensFromUsage is the size of the last request in the normalized
// usage shape every driver already produces ({input_tokens, output_tokens,
// cache_read_input_tokens, cache_creation_input_tokens}, claude-named):
// what was sent plus what came back, cache reads and writes included, since
// all of it sat in the context window.
export function contextTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}
