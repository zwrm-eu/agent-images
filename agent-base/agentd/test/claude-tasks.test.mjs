// Background-task ledger tests (#1251). Fixtures mirror the SDK 0.3.201
// system-message shapes (sdk.d.ts: SDKTaskStartedMessage /
// SDKTaskUpdatedMessage / SDKTaskNotificationMessage) — the ledger is a pure
// function precisely so it can be tested without the SDK. The lifecycle
// claims behind these shapes (foreground tasks settle before the result,
// interrupt behavior) are validated against the real harness per the plan;
// these tests pin the ledger transitions only. The level tests (#1712) use
// the SDK 0.3.289 SDKBackgroundTasksChangedMessage shape, and one replays the
// order a live 2.1.289 session sent on 2026-10-09.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyTaskMessage,
  clearTaskLedger,
  countBackgroundTasks,
  createTaskLedger,
  levelTaskTtlMs,
  shellCeilingMs,
  BACKGROUND_TASK_TTL_MS,
} from '../drivers/claude-tasks.mjs'

const HOUR = 60 * 60 * 1000
// The driver's default shell ceiling (CLAUDE_SESSION_ENV in claude.mjs).
const DRIVER_ENV = { BASH_MAX_TIMEOUT_MS: String(24 * HOUR) }

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
  const ledger = createTaskLedger()
  assert.equal(applyTaskMessage(ledger, started('t1')), true)
  assert.equal(countBackgroundTasks(ledger), 1)
  assert.equal(applyTaskMessage(ledger, notification('t1')), true)
  assert.equal(countBackgroundTasks(ledger), 0)
})

test('notification settles regardless of status', () => {
  for (const status of ['completed', 'failed', 'stopped']) {
    const ledger = createTaskLedger()
    applyTaskMessage(ledger, started('t1'))
    applyTaskMessage(ledger, notification('t1', status))
    assert.equal(countBackgroundTasks(ledger), 0, status)
  }
})

test('task_updated settles on terminal statuses only', () => {
  for (const status of ['completed', 'failed', 'killed']) {
    const ledger = createTaskLedger()
    applyTaskMessage(ledger, started('t1'))
    assert.equal(applyTaskMessage(ledger, updated('t1', status)), true, status)
    assert.equal(countBackgroundTasks(ledger), 0, status)
  }
  // pending/running/paused keep counting — a paused task still holds guest
  // state worth preserving.
  for (const status of ['pending', 'running', 'paused']) {
    const ledger = createTaskLedger()
    applyTaskMessage(ledger, started('t1'))
    assert.equal(applyTaskMessage(ledger, updated('t1', status)), false, status)
    assert.equal(countBackgroundTasks(ledger), 1, status)
  }
})

test('duplicate notification is a no-op', () => {
  const ledger = createTaskLedger()
  applyTaskMessage(ledger, started('t1'))
  applyTaskMessage(ledger, notification('t1'))
  assert.equal(applyTaskMessage(ledger, notification('t1')), false)
  assert.equal(countBackgroundTasks(ledger), 0)
})

test('settle for an unknown task is a no-op', () => {
  const ledger = createTaskLedger()
  assert.equal(applyTaskMessage(ledger, notification('ghost')), false)
  assert.equal(applyTaskMessage(ledger, updated('ghost', 'completed')), false)
  assert.equal(countBackgroundTasks(ledger), 0)
})

test('unrelated messages are ignored', () => {
  const ledger = createTaskLedger()
  assert.equal(applyTaskMessage(ledger, { type: 'system', subtype: 'task_progress', task_id: 't1' }), false)
  assert.equal(applyTaskMessage(ledger, { type: 'system', subtype: 'init', session_id: 'x' }), false)
  assert.equal(applyTaskMessage(ledger, { type: 'assistant', message: {} }), false)
  assert.equal(applyTaskMessage(ledger, { type: 'system', subtype: 'task_started' }), false) // no task_id
  assert.equal(countBackgroundTasks(ledger), 0)
})

test('re-started task refreshes its entry in place', () => {
  const ledger = createTaskLedger()
  applyTaskMessage(ledger, started('t1'), 1000)
  applyTaskMessage(ledger, started('t1'), 2000)
  assert.equal(ledger.tasks.size, 1)
  assert.equal(ledger.tasks.get('t1').ts, 2000)
})

test('TTL expires leaked entries at read time', () => {
  const ledger = createTaskLedger()
  applyTaskMessage(ledger, started('leaked'), 0)
  applyTaskMessage(ledger, started('fresh'), BACKGROUND_TASK_TTL_MS)
  assert.equal(countBackgroundTasks(ledger, BACKGROUND_TASK_TTL_MS), 1)
  assert.equal(countBackgroundTasks(ledger, BACKGROUND_TASK_TTL_MS - 1), 2)
  // Expiry is a read-time view, not a mutation — a late settle still lands.
  assert.equal(ledger.tasks.size, 2)
  assert.equal(applyTaskMessage(ledger, notification('leaked')), true)
  assert.equal(ledger.tasks.size, 1)
})

test('liveness signals refresh the TTL clock', () => {
  const ledger = createTaskLedger()
  applyTaskMessage(ledger, started('t1'), 0)
  // Progress at the TTL boundary proves the task alive — the clock restarts,
  // so it still counts long after the original start.
  assert.equal(applyTaskMessage(ledger, { type: 'system', subtype: 'task_progress', task_id: 't1' }, BACKGROUND_TASK_TTL_MS), false)
  assert.equal(countBackgroundTasks(ledger, BACKGROUND_TASK_TTL_MS + 1000), 1)
  // Non-terminal patches refresh too.
  applyTaskMessage(ledger, updated('t1', 'running'), 2 * BACKGROUND_TASK_TTL_MS)
  assert.equal(countBackgroundTasks(ledger, 2 * BACKGROUND_TASK_TTL_MS + 1000), 1)
})

test('ambient tasks are not counted as background work (SDK >= 0.3.289)', () => {
  const ledger = createTaskLedger()
  assert.equal(applyTaskMessage(ledger, { type: 'system', subtype: 'task_started', task_id: 'w1', ambient: true }), false)
  assert.equal(applyTaskMessage(ledger, { type: 'system', subtype: 'task_started', task_id: 's1', skip_transcript: true }), false)
  assert.equal(countBackgroundTasks(ledger), 0)
  // Their notifications are harmless no-ops.
  assert.equal(applyTaskMessage(ledger, { type: 'system', subtype: 'task_notification', task_id: 'w1' }), false)
  assert.equal(applyTaskMessage(ledger, { type: 'system', subtype: 'task_started', task_id: 'b1' }), true)
  assert.equal(countBackgroundTasks(ledger), 1)
})

// level builds a background_tasks_changed payload; an entry is an id, or
// [id, {ambient: true}].
const level = (...entries) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: entries.map((e) => {
    const [id, extra] = Array.isArray(e) ? e : [e, {}]
    return { task_id: id, task_type: 'local_bash', description: `task ${id}`, ...extra }
  }),
  uuid: 'u',
  session_id: 's',
})

test('the level replaces the set and reports membership changes only (#1712)', () => {
  const ledger = createTaskLedger()
  assert.equal(applyTaskMessage(ledger, level('a', 'b')), true)
  assert.equal(ledger.level, true)
  assert.equal(countBackgroundTasks(ledger), 2)
  assert.equal(applyTaskMessage(ledger, level('a')), true)
  assert.equal(countBackgroundTasks(ledger), 1)
  assert.equal(applyTaskMessage(ledger, level('a')), false, 'same membership is no change')
  assert.equal(applyTaskMessage(ledger, level('b')), true, 'same size, different member')
  assert.equal(applyTaskMessage(ledger, level()), true)
  assert.equal(countBackgroundTasks(ledger), 0)
})

test('ambient entries in the level are not counted (#1712)', () => {
  const ledger = createTaskLedger()
  assert.equal(applyTaskMessage(ledger, level(['w', { ambient: true }])), false)
  assert.equal(countBackgroundTasks(ledger), 0)
  assert.equal(applyTaskMessage(ledger, level('a', ['w', { ambient: true }])), true)
  assert.equal(countBackgroundTasks(ledger), 1)
  // A flip to ambient drops the entry.
  assert.equal(applyTaskMessage(ledger, level(['a', { ambient: true }])), true)
  assert.equal(countBackgroundTasks(ledger), 0)
})

test('a malformed level is ignored and does not switch the source (#1712)', () => {
  const ledger = createTaskLedger()
  applyTaskMessage(ledger, started('t1'))
  assert.equal(applyTaskMessage(ledger, { type: 'system', subtype: 'background_tasks_changed' }), false)
  assert.equal(ledger.level, false)
  assert.equal(countBackgroundTasks(ledger), 1)
  // Entries without a string id are skipped, the rest still count.
  assert.equal(applyTaskMessage(ledger, { ...level('a'), tasks: [{ task_id: 7 }, null, { task_id: 'a' }] }), true)
  assert.equal(countBackgroundTasks(ledger), 1)
  assert.ok(ledger.tasks.has('a'))
})

test('under the level, task_started adds nothing: it fires for foreground tasks too (#1712)', () => {
  const ledger = createTaskLedger()
  applyTaskMessage(ledger, level('a'))
  assert.equal(applyTaskMessage(ledger, started('fg', { is_backgrounded: false })), false)
  assert.equal(applyTaskMessage(ledger, started('a', { is_backgrounded: true })), false)
  assert.equal(countBackgroundTasks(ledger), 1)
})

test('entries tracked from edges before the first level are replaced by it (#1712)', () => {
  const ledger = createTaskLedger()
  // Ordering against the edges is unspecified: the started edge may come first.
  applyTaskMessage(ledger, started('a'), 0)
  applyTaskMessage(ledger, started('fg'), 0)
  assert.equal(applyTaskMessage(ledger, level('a'), 5), true)
  assert.deepEqual([...ledger.tasks.keys()], ['a'])
  assert.equal(ledger.tasks.get('a').ts, 5)
})

test('settle edges remove level entries, in either order against the level (#1712)', () => {
  // Level first (the order 2.1.289 uses in practice).
  let ledger = createTaskLedger()
  applyTaskMessage(ledger, level('a', 'b'))
  applyTaskMessage(ledger, level('a'))
  assert.equal(applyTaskMessage(ledger, updated('b', 'killed')), false)
  assert.equal(applyTaskMessage(ledger, notification('b', 'stopped')), false)
  assert.equal(countBackgroundTasks(ledger), 1)
  // Edges first.
  ledger = createTaskLedger()
  applyTaskMessage(ledger, level('a', 'b'))
  assert.equal(applyTaskMessage(ledger, notification('b')), true)
  assert.equal(applyTaskMessage(ledger, level('a')), false)
  assert.equal(countBackgroundTasks(ledger), 1)
})

test('a lost final level is covered by the settle edges (#1712)', () => {
  const ledger = createTaskLedger()
  applyTaskMessage(ledger, level('a'))
  // The level emptying the set never arrives.
  applyTaskMessage(ledger, notification('a'))
  assert.equal(countBackgroundTasks(ledger), 0)
})

test('a level-confirmed shell keeps counting past the 2 h edge TTL (#1712)', () => {
  const ledger = createTaskLedger(DRIVER_ENV)
  assert.equal(ledger.levelTtlMs, 25 * HOUR)
  applyTaskMessage(ledger, level('long'), 0)
  // 2.1.289 sends no task_progress for shells: nothing refreshes the clock.
  assert.equal(countBackgroundTasks(ledger, BACKGROUND_TASK_TTL_MS + 60_000), 1)
  assert.equal(countBackgroundTasks(ledger, 24 * HOUR), 1, 'the 24 h shell ceiling')
  assert.equal(countBackgroundTasks(ledger, 25 * HOUR - 1), 1)
  assert.equal(countBackgroundTasks(ledger, 25 * HOUR), 0, 'a task the CLI never times out still expires')
})

test('the level TTL follows a raised shell ceiling (#1712)', () => {
  const ledger = createTaskLedger({ BASH_MAX_TIMEOUT_MS: String(48 * HOUR) })
  applyTaskMessage(ledger, level('long'), 0)
  assert.equal(countBackgroundTasks(ledger, 40 * HOUR), 1)
  assert.equal(countBackgroundTasks(ledger, 49 * HOUR), 0)
})

test('shellCeilingMs mirrors the 2.1.289 CLI (#1712)', () => {
  const cap = 2 ** 31 - 1
  assert.equal(shellCeilingMs({}), 2 * HOUR, 'unset: the 2 h floor')
  assert.equal(shellCeilingMs(DRIVER_ENV), 24 * HOUR)
  assert.equal(shellCeilingMs({ BASH_MAX_TIMEOUT_MS: ' 172800000 ' }), 48 * HOUR, 'trimmed')
  assert.equal(shellCeilingMs({ BASH_MAX_TIMEOUT_MS: '600000' }), 2 * HOUR, 'below the floor')
  assert.equal(shellCeilingMs({ BASH_MAX_TIMEOUT_MS: '0' }), 2 * HOUR, 'non-positive falls back')
  assert.equal(shellCeilingMs({ BASH_DEFAULT_TIMEOUT_MS: String(3 * HOUR) }), 3 * HOUR, 'the default raises the max')
  assert.equal(shellCeilingMs({ BASH_MAX_TIMEOUT_MS: String(3 * HOUR), BASH_DEFAULT_TIMEOUT_MS: String(5 * HOUR) }), 5 * HOUR)
  assert.equal(shellCeilingMs({ BASH_MAX_TIMEOUT_MS: '99999999999' }), cap, 'capped at 2^31-1')
  assert.equal(shellCeilingMs({ BASH_MAX_TIMEOUT_MS: '48h' }), cap, 'a value the CLI may read differently counts as the cap')
  for (const env of [{}, DRIVER_ENV, { BASH_MAX_TIMEOUT_MS: '99999999999' }]) {
    assert.ok(levelTaskTtlMs(env) > shellCeilingMs(env), 'a shell always ends before its entry expires')
  }
})

test('each level restarts the clock of every task it lists (#1712)', () => {
  const ledger = createTaskLedger(DRIVER_ENV)
  applyTaskMessage(ledger, level('a'), 0)
  applyTaskMessage(ledger, level('a', 'b'), 10 * HOUR)
  assert.equal(countBackgroundTasks(ledger, 25 * HOUR + 1000), 2)
})

test('an edge-only CLI keeps the 2 h TTL (#1712)', () => {
  const ledger = createTaskLedger()
  applyTaskMessage(ledger, started('t1'), 0)
  assert.equal(ledger.level, false)
  assert.equal(countBackgroundTasks(ledger, BACKGROUND_TASK_TTL_MS), 0)
})

test('clearTaskLedger empties the ledger', () => {
  const ledger = createTaskLedger()
  applyTaskMessage(ledger, level('a', 'b'))
  clearTaskLedger(ledger)
  assert.equal(countBackgroundTasks(ledger), 0)
})

test('replay of a live 2.1.289 session: a 3 h shell, a default-timeout shell, then SIGTERM (#1712)', () => {
  // Message order from session f8703567 on v0.31.6, 2026-10-09 (seqs 183-339).
  const H = HOUR
  const ledger = createTaskLedger(DRIVER_ENV)
  const at = (msg, t) => applyTaskMessage(ledger, msg, t)
  at(level('brypg0t00'), 0)
  at(started('brypg0t00', { is_backgrounded: true, task_type: 'local_bash' }), 1)
  at(level('brypg0t00', 'bc8iv6ig1'), 600)
  at(started('bc8iv6ig1', { is_backgrounded: true, task_type: 'local_bash' }), 601)
  assert.equal(countBackgroundTasks(ledger, 1000), 2)
  // +30 min: the default-timeout shell is killed; the level leads its edges.
  at(level('brypg0t00'), 0.5 * H)
  at(updated('bc8iv6ig1', 'killed'), 0.5 * H)
  at(notification('bc8iv6ig1', 'stopped'), 0.5 * H)
  assert.equal(countBackgroundTasks(ledger, 0.5 * H + 1), 1)
  // The 3 h shell outlives the old 2 h TTL.
  assert.equal(countBackgroundTasks(ledger, 2.5 * H), 1)
  // SIGTERM: here the notification leads the level.
  at(notification('brypg0t00', 'stopped'), 2.6 * H)
  at(level(), 2.6 * H)
  at(updated('brypg0t00', 'failed'), 2.6 * H)
  assert.equal(countBackgroundTasks(ledger, 2.6 * H), 0)
})
