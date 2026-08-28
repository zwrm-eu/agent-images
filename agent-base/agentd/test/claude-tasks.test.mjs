// Background-task ledger tests (#1251). Fixtures mirror the SDK 0.3.201
// system-message shapes (sdk.d.ts: SDKTaskStartedMessage /
// SDKTaskUpdatedMessage / SDKTaskNotificationMessage) — the ledger is a pure
// function precisely so it can be tested without the SDK. The lifecycle
// claims behind these shapes (foreground tasks settle before the result,
// interrupt behavior) are validated against the real harness per the plan;
// these tests pin the ledger transitions only.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyTaskMessage,
  countBackgroundTasks,
  BACKGROUND_TASK_TTL_MS,
} from '../drivers/claude-tasks.mjs'

const started = (id, extra = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: id,
  description: `task ${id}`,
  ...extra,
})
const updated = (id, status) => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: id,
  patch: { status },
})
const notification = (id, status = 'completed') => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: id,
  status,
  output_file: '/tmp/x',
  summary: 'done',
})

test('started then notification settles', () => {
  const tasks = new Map()
  assert.equal(applyTaskMessage(tasks, started('t1')), true)
  assert.equal(countBackgroundTasks(tasks), 1)
  assert.equal(applyTaskMessage(tasks, notification('t1')), true)
  assert.equal(countBackgroundTasks(tasks), 0)
})

test('notification settles regardless of status', () => {
  for (const status of ['completed', 'failed', 'stopped']) {
    const tasks = new Map()
    applyTaskMessage(tasks, started('t1'))
    applyTaskMessage(tasks, notification('t1', status))
    assert.equal(countBackgroundTasks(tasks), 0, status)
  }
})

test('task_updated settles on terminal statuses only', () => {
  for (const status of ['completed', 'failed', 'killed']) {
    const tasks = new Map()
    applyTaskMessage(tasks, started('t1'))
    assert.equal(applyTaskMessage(tasks, updated('t1', status)), true, status)
    assert.equal(countBackgroundTasks(tasks), 0, status)
  }
  // pending/running/paused keep counting — a paused task still holds guest
  // state worth preserving.
  for (const status of ['pending', 'running', 'paused']) {
    const tasks = new Map()
    applyTaskMessage(tasks, started('t1'))
    assert.equal(applyTaskMessage(tasks, updated('t1', status)), false, status)
    assert.equal(countBackgroundTasks(tasks), 1, status)
  }
})

test('duplicate notification is a no-op', () => {
  const tasks = new Map()
  applyTaskMessage(tasks, started('t1'))
  applyTaskMessage(tasks, notification('t1'))
  assert.equal(applyTaskMessage(tasks, notification('t1')), false)
  assert.equal(countBackgroundTasks(tasks), 0)
})

test('settle for an unknown task is a no-op', () => {
  const tasks = new Map()
  assert.equal(applyTaskMessage(tasks, notification('ghost')), false)
  assert.equal(applyTaskMessage(tasks, updated('ghost', 'completed')), false)
  assert.equal(countBackgroundTasks(tasks), 0)
})

test('unrelated messages are ignored', () => {
  const tasks = new Map()
  assert.equal(applyTaskMessage(tasks, { type: 'system', subtype: 'task_progress', task_id: 't1' }), false)
  assert.equal(applyTaskMessage(tasks, { type: 'system', subtype: 'init', session_id: 'x' }), false)
  assert.equal(applyTaskMessage(tasks, { type: 'assistant', message: {} }), false)
  assert.equal(applyTaskMessage(tasks, { type: 'system', subtype: 'task_started' }), false) // no task_id
  assert.equal(countBackgroundTasks(tasks), 0)
})

test('re-started task refreshes its entry in place', () => {
  const tasks = new Map()
  applyTaskMessage(tasks, started('t1'), 1000)
  applyTaskMessage(tasks, started('t1'), 2000)
  assert.equal(tasks.size, 1)
  assert.equal(tasks.get('t1').ts, 2000)
})

test('TTL expires leaked entries at read time', () => {
  const tasks = new Map()
  applyTaskMessage(tasks, started('leaked'), 0)
  applyTaskMessage(tasks, started('fresh'), BACKGROUND_TASK_TTL_MS)
  assert.equal(countBackgroundTasks(tasks, BACKGROUND_TASK_TTL_MS), 1)
  assert.equal(countBackgroundTasks(tasks, BACKGROUND_TASK_TTL_MS - 1), 2)
  // Expiry is a read-time view, not a mutation — a late settle still lands.
  assert.equal(tasks.size, 2)
  assert.equal(applyTaskMessage(tasks, notification('leaked')), true)
  assert.equal(tasks.size, 1)
})

test('liveness signals refresh the TTL clock', () => {
  const tasks = new Map()
  applyTaskMessage(tasks, started('t1'), 0)
  // Progress at the TTL boundary proves the task alive — the clock restarts,
  // so it still counts long after the original start.
  assert.equal(applyTaskMessage(tasks, { type: 'system', subtype: 'task_progress', task_id: 't1' }, BACKGROUND_TASK_TTL_MS), false)
  assert.equal(countBackgroundTasks(tasks, BACKGROUND_TASK_TTL_MS + 1000), 1)
  // Non-terminal patches refresh too.
  applyTaskMessage(tasks, updated('t1', 'running'), 2 * BACKGROUND_TASK_TTL_MS)
  assert.equal(countBackgroundTasks(tasks, 2 * BACKGROUND_TASK_TTL_MS + 1000), 1)
})
