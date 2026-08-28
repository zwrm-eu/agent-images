// Pure translators from codex app-server shapes to the claude-stream-json-shaped
// payloads the platform's event contract is built on (#1088). Kept free of I/O
// and codex imports so `node --test` covers them without an API key.
//
// Load-bearing consumers of these shapes (do not change without reading them):
//  - applyEventMeta (api/handlers/agent_sessions.go): sdk.system init
//    .session_id = resume handle; sdk.result .total_cost_usd (CUMULATIVE per
//    session row) + .result (run summary); sdk.result presence = run
//    completion gate.
//  - dashboard agentTranscript.ts: assistant/user content blocks;
//    partialTextDelta reads payload.event.content_block_delta.delta.text_delta.
//  - changed-files.mjs: fileChange becomes an apply_patch tool with explicit
//    add/update/delete kinds, which determine the changed-file operation.
//
// Transcript shape: codex reports each thread item twice (item/started, then
// item/completed). To land a claude-shaped transcript we emit the tool_use
// block on `started` and the matching tool_result on `completed`, while plain
// agentMessage/reasoning items emit once, on `completed`.

import { canonicalToolName } from './codex-tools.mjs'

// initPayload synthesizes the claude `system/init` message for a codex thread.
// session_id carries the codex THREAD ID — the durable resume handle
// (`thread/resume` takes it; rollouts live under ~/.codex/sessions on the
// workspace volume, so resume survives VM destroy).
export function initPayload(threadId, model) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: threadId || '',
    model: model || '',
    harness: 'codex',
  }
}

// toolNameFor derives the tool name shown in the transcript AND matched by the
// escalation gate. Bridged connector tools go on the codex wire under a
// non-reserved prefix and are canonicalized back here, so their
// `mcp__<slug>__<tool>` identity is the same on every harness (#1090).
export function toolNameFor(item) {
  switch (item?.type) {
    case 'commandExecution':
      return 'shell'
    case 'fileChange':
      return 'apply_patch'
    case 'mcpToolCall':
      return `mcp__${item.server ?? ''}__${item.tool ?? ''}`
    case 'dynamicToolCall':
      // Bridged tools go on the wire under a non-reserved prefix (codex
      // reserves `mcp__`), but the TRANSCRIPT must carry the platform's
      // canonical name — the same one the permission request carries and the
      // same one claude and pi record. Otherwise one tool call appears under
      // two names, and anything keyed on the mcp__<slug>__ convention misses
      // codex sessions entirely.
      return canonicalToolName(item.tool ?? '')
    case 'webSearch':
      return 'web_search'
    default:
      return item?.type ?? ''
  }
}

// toolInputFor renders the tool_use `input` — the arguments a reviewer sees in
// an approval prompt, so it must carry what the call actually does.
export function toolInputFor(item) {
  switch (item?.type) {
    case 'commandExecution':
      return { command: item.command ?? '', cwd: item.cwd ?? '' }
    case 'fileChange':
      return { changes: (item.changes || []).map((c) => ({ path: c?.path ?? '', kind: c?.kind ?? '' })) }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return item.arguments ?? {}
    case 'webSearch':
      return { query: item.query ?? '' }
    default:
      return {}
  }
}

// isToolItem marks the item types that render as a tool_use/tool_result pair.
export function isToolItem(item) {
  return (
    item?.type === 'commandExecution' ||
    item?.type === 'fileChange' ||
    item?.type === 'mcpToolCall' ||
    item?.type === 'dynamicToolCall' ||
    item?.type === 'webSearch'
  )
}

// mcpContentText flattens MCP content blocks (the raw JSON the server
// returned) to the text a transcript renders.
function mcpContentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
}

// toolResultText renders a completed item's output for the tool_result block.
export function toolResultText(item) {
  switch (item?.type) {
    case 'commandExecution': {
      const out = item.aggregatedOutput ?? ''
      const code = item.exitCode
      return typeof code === 'number' && code !== 0 ? `${out}\n(exit code ${code})`.trim() : out
    }
    case 'fileChange':
      return (item.changes || []).map((c) => `${c?.kind ?? 'update'} ${c?.path ?? ''}`).join('\n')
    case 'mcpToolCall':
      if (item.error) return String(item.error.message ?? '')
      return mcpContentText(item.result?.content)
    case 'dynamicToolCall':
      return (item.contentItems || [])
        .map((c) => (c?.type === 'inputText' ? c.text ?? '' : ''))
        .filter(Boolean)
        .join('\n')
    case 'webSearch':
      return item.query ?? ''
    default:
      return ''
  }
}

// toolFailed reports whether the completed item should carry is_error. Each
// item type spells failure differently; `declined` is a user denial.
export function toolFailed(item) {
  switch (item?.type) {
    case 'commandExecution':
      return item.status === 'failed' || item.status === 'declined' ||
        (typeof item.exitCode === 'number' && item.exitCode !== 0)
    case 'fileChange':
      // PatchApplyStatus carries the same four values as a command's:
      // 'declined' is a human denial and must not render as a success — both
      // the operator reading the timeline and the MODEL reading the
      // tool_result would otherwise be told a denied patch was applied.
      return item.status === 'failed' || item.status === 'declined'
    case 'mcpToolCall':
      return item.status === 'failed' || Boolean(item.error)
    case 'dynamicToolCall':
      return item.success === false
    default:
      return false
  }
}

// toolUsePayload maps an item/started tool item to the claude `assistant`
// message carrying a tool_use block.
export function toolUsePayload(item, model) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: item?.id ?? '', name: toolNameFor(item), input: toolInputFor(item) }],
      model: model || '',
    },
  }
}

// toolResultPayload maps an item/completed tool item to the claude `user`
// message carrying a tool_result block.
export function toolResultPayload(item) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: item?.id ?? '',
        content: toolResultText(item),
        ...(toolFailed(item) ? { is_error: true } : {}),
      }],
    },
  }
}

// messagePayload maps a completed agentMessage/reasoning item to the claude
// `assistant` shape. Reasoning prefers the summary (what codex intends to
// show) and falls back to raw content.
export function messagePayload(item, model) {
  const blocks = []
  if (item?.type === 'agentMessage') {
    blocks.push({ type: 'text', text: item.text ?? '' })
  } else if (item?.type === 'reasoning') {
    const parts = (item.summary?.length ? item.summary : item.content) || []
    const text = parts.filter((p) => typeof p === 'string' && p).join('\n')
    blocks.push({ type: 'thinking', thinking: text })
  }
  return { type: 'assistant', message: { role: 'assistant', content: blocks, model: model || '' } }
}

// usagePayload maps a codex TokenUsageBreakdown to the claude usage field
// names the dashboard/CP read. Note codex's inputTokens is understood to
// INCLUDE cachedInputTokens, while claude reports them disjointly — the two
// are surfaced as reported rather than differenced, since codex sessions are
// unmetered (#1089) and these numbers are display-only.
export function usagePayload(u) {
  if (!u || typeof u !== 'object') return undefined
  return {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    cache_read_input_tokens: u.cachedInputTokens ?? 0,
    cache_creation_input_tokens: 0,
  }
}

// partialPayload maps a codex agent-message delta to the claude stream_event
// shape partialTextDelta() reads. Returns null for empty deltas.
export function partialPayload(params) {
  const delta = params?.delta
  if (typeof delta !== 'string' || delta === '') return null
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: delta },
    },
  }
}

// resultPayload builds the claude `result` message for a completed codex turn.
//
// total_cost_usd is ALWAYS 0 for codex: the app-server reports token usage but
// never cost, and the platform decision (#1089) is a priced-alias-free catalog
// — codex agents spend the org's own OPENAI_API_KEY and are not metered, so
// nothing here debits credits. The CP banks GREATEST-diffs per session row, so
// a constant 0 accrues nothing, which is the intent.
export function resultPayload({ subtype = 'success', resultText = '', usage, numTurns = 1, durationMS = 0 }) {
  return {
    type: 'result',
    subtype,
    result: resultText,
    ...(subtype !== 'success' ? { is_error: true } : {}),
    total_cost_usd: 0,
    num_turns: numTurns,
    duration_ms: durationMS,
    ...(usage ? { usage: usagePayload(usage) } : {}),
  }
}

// codexErrorCode extracts the CodexErrorInfo discriminant, which is either a
// bare string ("unauthorized") or a single-key object
// ({"httpConnectionFailed": {...}}).
export function codexErrorCode(info) {
  if (typeof info === 'string') return info
  if (info && typeof info === 'object') {
    const keys = Object.keys(info)
    if (keys.length > 0) return keys[0]
  }
  return ''
}

// classifyCodexError mirrors claude's classifyRunError for app-server
// failures. Codex hands us a typed CodexErrorInfo where it can, so the
// taxonomy keys off that first and only falls back to string matching.
export function classifyCodexError(err) {
  const raw = String(err?.stack || err?.message || err)
  const shortMsg = String(err?.message || err)
  // Two carriers: a turn failure hands us a typed CodexErrorInfo, while
  // CodexRPCError puts its own tag (e.g. 'processExit') on `.code`. `.data` is
  // NOT a fallback for the tag — for a process exit it holds {code, signal}.
  const code = codexErrorCode(err?.codexErrorInfo) ||
    (typeof err?.code === 'string' ? err.code : '') ||
    codexErrorCode(err?.data)

  if (code === 'unauthorized' || /401|unauthorized|invalid.*api.*key|authentication/i.test(raw)) {
    return {
      cause: 'auth',
      message: 'OpenAI API authentication failed — the model key was rejected. Check the agent\'s OPENAI_API_KEY secret.',
      detail: raw,
    }
  }
  if (code === 'usageLimitExceeded' || code === 'serverOverloaded' || /429|rate.?limit|overloaded/i.test(raw)) {
    return {
      cause: 'rate_limited',
      message: 'The OpenAI API rate-limited or usage-limited the session. Retry shortly.',
      detail: raw,
    }
  }
  if (/insufficient.*(quota|credit)|billing|payment/i.test(raw)) {
    return {
      cause: 'billing',
      message: 'The OpenAI API rejected the request for billing reasons — check the OpenAI account.',
      detail: raw,
    }
  }
  if (code === 'contextWindowExceeded') {
    return {
      cause: 'error',
      message: 'The conversation exceeded the model\'s context window.',
      detail: raw,
    }
  }
  if (code === 'processExit') {
    return {
      cause: 'crashed',
      message: 'The codex app-server exited unexpectedly.',
      detail: raw,
    }
  }
  return { cause: 'error', message: shortMsg, detail: raw }
}

// mapEffort passes a platform effort level through to codex.
//
// It does NOT narrow per model, and must not try to: which levels a model
// accepts is catalog knowledge (gpt-5.6-* take `max`, gpt-5.5 and gpt-5.2 stop
// at `xhigh`), and the catalog lives in the control plane, which resolves the
// model and clamps the effort to it before either ever reaches this daemon
// (state.ClampCodexEffort, #1089). A second, model-blind clamp here could only
// disagree with the one that was persisted.
//
// The set below is therefore a sanity filter, not a policy: an unrecognized
// level is dropped rather than forwarded, because the app-server validates
// NOTHING locally — probed against the pinned 0.145.0, a turn/start carrying
// the literal string 'bogus-effort' is accepted and opens a turn. Dropping
// falls back to the model's own default, which is the safe end of that trade.
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
export function mapEffort(effort) {
  return CODEX_EFFORTS.has(effort) ? effort : undefined
}

// approvalPolicyFor maps the platform permission mode onto codex's approval +
// sandbox pair. bypassPermissions runs unattended: the microVM (plus its
// egress policy) is the real boundary, so codex's own in-process sandbox is
// disabled rather than fighting the workspace. `default` asks on request and
// keeps codex's workspace-write sandbox.
export function approvalPolicyFor(mode) {
  if (mode === 'bypassPermissions') {
    return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
  }
  return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
}

// sandboxConfigFor renders the `config` overrides that go with the sandbox.
//
// workspace-write DENIES NETWORK BY DEFAULT (`SandboxPolicy.networkAccess` is
// documented false unless set, and the running binary confirms it), which
// would make every dependency install, git push and curl fail inside the
// permission mode the approval gate exists for — with no error the agent could
// interpret. Network isolation is the VM's job (egress policy), not codex's,
// so it is turned back on explicitly.
export function sandboxConfigFor(mode) {
  if (mode === 'bypassPermissions') return {}
  return { sandbox_workspace_write: { network_access: true } }
}

// sandboxPolicyFor is the STRUCTURED sandbox for a per-turn override, which is
// how a mid-session permission-mode switch actually moves the sandbox —
// `turn/start` takes `sandboxPolicy`, and only `thread/start` takes the plain
// `sandbox` string. Without this a switch changes whether codex ASKS while
// leaving what it may DO untouched.
//
// The shape is version-sensitive (0.111 carried a `readOnlyAccess` field that
// 0.145 dropped), so it tracks the pinned @openai/codex in the Dockerfile;
// re-verify it when moving that pin.
export function sandboxPolicyFor(mode, cwd) {
  if (mode === 'bypassPermissions') return { type: 'dangerFullAccess' }
  return {
    type: 'workspaceWrite',
    writableRoots: cwd ? [cwd] : [],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}
