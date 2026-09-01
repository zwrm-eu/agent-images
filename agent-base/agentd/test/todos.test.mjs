import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTodos, todosFromCodexItem, createTodoTracker } from '../drivers/todos.mjs'

test('normalizeTodos strips activeForm and validates status/priority', () => {
  assert.deepEqual(
    normalizeTodos([
      { content: 'a', status: 'in_progress', activeForm: 'doing a' },
      { content: 'b', status: 'completed', priority: 'high' },
      { content: 'c', status: 'made-up', priority: 'urgent' },
    ]),
    [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'completed', priority: 'high' },
      // An unknown status degrades to pending; a hole in the list would
      // mislead more than a conservative status does.
      { content: 'c', status: 'pending' },
    ],
  )
})

test('normalizeTodos drops entries without content but keeps the list', () => {
  assert.deepEqual(normalizeTodos([{ status: 'pending' }, null, { content: '' }]), [])
})

test('normalizeTodos refuses non-lists — a malformed call is not an empty list', () => {
  assert.equal(normalizeTodos(undefined), null)
  assert.equal(normalizeTodos({ todos: [] }), null)
})

test('todosFromCodexItem maps text/completed onto the wire shape', () => {
  assert.deepEqual(
    todosFromCodexItem({ type: 'todoList', items: [{ text: 'a', completed: true }, { text: 'b', completed: false }, { text: '' }] }),
    [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }],
  )
  assert.equal(todosFromCodexItem({ type: 'agentMessage', text: 'hi' }), null)
  assert.equal(todosFromCodexItem({ type: 'todoList' }), null)
})

const assistantMsg = (blocks, extra = {}) => ({ message: { content: blocks }, ...extra })

test('the tracker emits only after a successful tool_result', () => {
  const emitted = []
  const tr = createTodoTracker((todos) => emitted.push(todos))
  tr.onAssistant(assistantMsg([{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } }]))
  assert.equal(emitted.length, 0, 'a tool_use alone is intent, not adoption')
  tr.onToolResult(assistantMsg([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]))
  assert.deepEqual(emitted, [[{ content: 'a', status: 'pending' }]])
  // A retried result for the same id must not re-emit.
  tr.onToolResult(assistantMsg([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]))
  assert.equal(emitted.length, 1)
})

test('a denied TodoWrite records nothing — the session never adopted the list', () => {
  const emitted = []
  const tr = createTodoTracker((todos) => emitted.push(todos))
  tr.onAssistant(assistantMsg([{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } }]))
  tr.onToolResult(assistantMsg([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'denied' }]))
  assert.deepEqual(emitted, [])
})

test('subagent TodoWrite traffic never clobbers the session list', () => {
  const emitted = []
  const tr = createTodoTracker((todos) => emitted.push(todos))
  const use = [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } }]
  tr.onAssistant(assistantMsg(use, { parent_tool_use_id: 'task-1' }))
  tr.onToolResult(assistantMsg([{ type: 'tool_result', tool_use_id: 't1' }], { parent_tool_use_id: 'task-1' }))
  // Even a result arriving WITHOUT the parent marker must not match: the
  // tool_use was never tracked.
  tr.onToolResult(assistantMsg([{ type: 'tool_result', tool_use_id: 't1' }]))
  assert.deepEqual(emitted, [])
})

test('synthetic resume replays never re-emit historical snapshots', () => {
  const emitted = []
  const tr = createTodoTracker((todos) => emitted.push(todos))
  tr.onAssistant(assistantMsg([{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } }], { isSynthetic: true }))
  tr.onToolResult(assistantMsg([{ type: 'tool_result', tool_use_id: 't1' }], { isSynthetic: true }))
  assert.deepEqual(emitted, [], 'the snapshot is already on the timeline from the original turn')
})

test('the tracker survives string message content and unrelated tools', () => {
  const emitted = []
  const tr = createTodoTracker((todos) => emitted.push(todos))
  tr.onAssistant({ message: { content: 'plain text' } })
  tr.onToolResult({ message: { content: 'plain text' } })
  tr.onAssistant(assistantMsg([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }]))
  tr.onToolResult(assistantMsg([{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }]))
  assert.deepEqual(emitted, [])
})

test('abandoned tool_use entries are capped, newest wins', () => {
  const emitted = []
  const tr = createTodoTracker((todos) => emitted.push(todos))
  for (let i = 0; i < 20; i++) {
    tr.onAssistant(assistantMsg([{ type: 'tool_use', id: `t${i}`, name: 'TodoWrite', input: { todos: [{ content: `todo ${i}`, status: 'pending' }] } }]))
  }
  tr.onToolResult(assistantMsg([{ type: 'tool_result', tool_use_id: 't0' }]))
  assert.equal(emitted.length, 0, 'the oldest abandoned entry was evicted')
  tr.onToolResult(assistantMsg([{ type: 'tool_result', tool_use_id: 't19' }]))
  assert.deepEqual(emitted, [[{ content: 'todo 19', status: 'pending' }]])
})
