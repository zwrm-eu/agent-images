// Task-list normalization (#1424). Every harness has its own todo tool —
// claude's TodoWrite, codex's todoList thread items, opencode's todowrite —
// and each used to ride the timeline as an opaque tool payload (codex's was
// dropped outright). Drivers funnel them through here into one durable
// `todo.updated` event carrying the FULL list, matching how the tools
// themselves write: wholesale replacement, never a diff. The control plane
// serves the newest event as GET .../sessions/{id}/todos; live consumers see
// the same frames on the events SSE.

const STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled'])
const PRIORITIES = new Set(['high', 'medium', 'low'])

// normalizeTodos maps a claude-shaped TodoWrite list ({content, status,
// activeForm?, priority?}) to the wire shape. An unknown status degrades to
// 'pending' rather than dropping the entry — a list with a hole misleads
// more than a conservative status does. Returns null when the input is not
// a list at all: a malformed tool call is not an empty list.
export function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  for (const t of raw) {
    if (!t || typeof t.content !== 'string' || t.content === '') continue
    const status = STATUSES.has(t.status) ? t.status : 'pending'
    out.push({ content: t.content, status, ...(PRIORITIES.has(t.priority) ? { priority: t.priority } : {}) })
  }
  return out
}

// todosFromCodexItem maps a codex `todoList` thread item to the wire shape.
// Codex models only text + completed; everything not completed is pending.
export function todosFromCodexItem(item) {
  if (item?.type !== 'todoList' || !Array.isArray(item.items)) return null
  const out = []
  for (const i of item.items) {
    if (!i || typeof i.text !== 'string' || i.text === '') continue
    out.push({ content: i.text, status: i.completed ? 'completed' : 'pending' })
  }
  return out
}

// createTodoTracker correlates claude TodoWrite tool_use blocks with their
// tool_result so `todo.updated` reflects EXECUTED updates only: in ask mode
// a human can deny the call, and emitting on the tool_use would record a
// list the session never adopted. Subagent traffic (parent_tool_use_id) is
// ignored — a Task's private plan must not clobber the session list — and so
// are synthetic messages: a resume replays historical tool pairs, and
// re-emitting them would duplicate snapshots already on the timeline.
export function createTodoTracker(emit) {
  const pending = new Map() // tool_use_id -> normalized todos
  const blocks = (msg) => (Array.isArray(msg?.message?.content) ? msg.message.content : [])
  return {
    onAssistant(msg) {
      if (msg?.parent_tool_use_id || msg?.isSynthetic) return
      for (const block of blocks(msg)) {
        if (block?.type !== 'tool_use' || block.name !== 'TodoWrite' || !block.id) continue
        const todos = normalizeTodos(block.input?.todos)
        if (!todos) continue
        pending.set(block.id, todos)
        // An interrupted turn can abandon a tool_use without a result; cap
        // the ledger so abandoned entries cannot accumulate for the
        // session's lifetime.
        if (pending.size > 16) pending.delete(pending.keys().next().value)
      }
    },
    onToolResult(msg) {
      if (msg?.parent_tool_use_id || msg?.isSynthetic) return
      for (const block of blocks(msg)) {
        if (block?.type !== 'tool_result') continue
        const todos = pending.get(block.tool_use_id)
        if (todos === undefined) continue
        pending.delete(block.tool_use_id)
        if (!block.is_error) emit(todos)
      }
    },
  }
}
