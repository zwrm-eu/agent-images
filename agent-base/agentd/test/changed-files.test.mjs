import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChangedFileTracker } from '../changed-files.mjs'

const message = (content) => ({ message: { content } })

test('changed files emit only after a successful structured tool result', () => {
  const tracker = new ChangedFileTracker()
  assert.deepEqual(tracker.observe('sdk.assistant', message([
    { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'src/new.ts' } },
  ])), [])
  assert.deepEqual(tracker.observe('sdk.user', message([
    { type: 'tool_result', tool_use_id: 'w1', content: 'ok' },
  ])), [{ path: 'src/new.ts', operation: 'written' }])
})

test('pending writes survive lifecycle events until the delayed tool result arrives', () => {
  const tracker = new ChangedFileTracker()
  tracker.observe('sdk.assistant', message([
    { type: 'tool_use', id: 'late', name: 'Write', input: { file_path: 'src/late.ts' } },
  ]))
  assert.deepEqual(tracker.observe('session.status', { state: 'idle' }), [])
  assert.deepEqual(tracker.observe('sdk.user', message([
    { type: 'tool_result', tool_use_id: 'late', content: 'ok' },
  ])), [{ path: 'src/late.ts', operation: 'written' }])
})

test('codex apply_patch changes preserve operation and failed tools are ignored', () => {
  const tracker = new ChangedFileTracker()
  tracker.observe('sdk.assistant', message([{ type: 'tool_use', id: 'p1', name: 'apply_patch', input: { changes: [
    { path: 'a.go', kind: 'update' }, { path: 'b.go', kind: 'delete' },
  ] } }]))
  assert.deepEqual(tracker.observe('sdk.user', message([{ type: 'tool_result', tool_use_id: 'p1', is_error: true }])), [])
  tracker.observe('sdk.assistant', message([{ type: 'tool_use', id: 'p2', name: 'apply_patch', input: { changes: [
    { path: 'a.go', kind: 'update' }, { path: 'b.go', kind: 'delete' },
  ] } }]))
  assert.deepEqual(tracker.observe('sdk.user', message([{ type: 'tool_result', tool_use_id: 'p2' }])), [
    { path: 'a.go', operation: 'modified' }, { path: 'b.go', operation: 'deleted' },
  ])
})
