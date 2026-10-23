// Shared platform-tool semantics (#1493, #1911): the validator, the park
// request and the wake text are one implementation, and every harness
// adapter must reject and accept exactly the same inputs before any park is
// created.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENDING,
  ENDING_WAIT,
  NEW_MESSAGE,
  NEW_MESSAGE_CANCELS,
  SLEEP_DESCRIPTION,
  WAIT_FOR_TASK_DESCRIPTION,
  parkCancellation,
  parkCancellations,
  parkDeadlineError,
  platformToolNames,
  runSleep,
  runSleepUntil,
  runWaitForTask,
  MAX_TASK_WAITS,
  sleepSeconds,
  sleepUntilDeadline,
  stillRunningText,
  waitForTaskArgs,
} from '../drivers/run-tools.mjs'
import { buildCodexRunTools } from '../drivers/codex-tools.mjs'
import { buildRunTools as buildPiRunTools } from '../drivers/pi-run-tools.mjs'
import { handlePlatformTool } from '../drivers/opencode-run-tools.mjs'
import { fakeHelpers as helpers } from './fake-park.mjs'

const MAX = 21600

const BAD_SECONDS = [undefined, null, 0, -1, 1.5, MAX + 1, '3', 'abc', NaN, Infinity, {}]
const GOOD_SECONDS = [1, 30, MAX]

test('the model-facing text states the cap in seconds and hours', () => {
  assert.match(SLEEP_DESCRIPTION(21600), /max 21600 = 6 hours/)
  assert.match(SLEEP_DESCRIPTION(3600), /max 3600 = 1 hour\)/)
})

test('sleepSeconds accepts only whole seconds within the cap, without coercion', () => {
  for (const v of GOOD_SECONDS) assert.deepEqual(sleepSeconds({ seconds: v }, MAX), { seconds: v })
  for (const v of BAD_SECONDS) {
    const r = sleepSeconds({ seconds: v }, MAX)
    assert.match(r.error, /integer between 1 and 21600/, JSON.stringify(v))
  }
  assert.match(sleepSeconds(undefined, MAX).error, /integer/)
})

test('sleepUntilDeadline validates the timestamp, the past and the cap boundary', () => {
  const now = Date.parse('2026-09-05T12:00:00Z')
  // Offset-less timestamps are refused everywhere, as claude's schema
  // already did: Date.parse would read them as host-local time.
  for (const v of ['nope', 42, undefined, null, '', '2026-09-05T18:00:00', '2026-09-05 18:00:00Z', 'Sat, 05 Sep 2026 18:00:00 GMT']) {
    assert.match(sleepUntilDeadline({ timestamp: v }, MAX, now).error, /invalid timestamp/, JSON.stringify(v))
  }
  assert.equal(sleepUntilDeadline({ timestamp: '2026-09-05T17:00:00.500Z' }, MAX, now).deadline, '2026-09-05T17:00:00.500Z')
  assert.equal(sleepUntilDeadline({ timestamp: '2026-09-05T18:30+05:30' }, MAX, now).deadline, '2026-09-05T13:00:00.000Z', 'offset without seconds')
  assert.match(sleepUntilDeadline({ timestamp: '2026-09-05T18:30+0530' }, MAX, now).error, /invalid timestamp/, 'offset without colon is not the ISO profile Date.parse guarantees')
  assert.match(sleepUntilDeadline({ timestamp: '2026-09-05T11:59:59Z' }, MAX, now).text, /already passed/)
  assert.match(sleepUntilDeadline({ timestamp: '2026-09-05T12:00:00Z' }, MAX, now).text, /already passed/)
  assert.deepEqual(sleepUntilDeadline({ timestamp: '2026-09-05T18:00:00Z' }, MAX, now), {
    timestamp: '2026-09-05T18:00:00Z',
    deadline: '2026-09-05T18:00:00.000Z',
  })
  assert.match(sleepUntilDeadline({ timestamp: '2026-09-05T18:00:01Z' }, MAX, now).error, /capped at 21600 seconds/)
  // An offset timestamp is normalised to UTC in the deadline.
  assert.equal(sleepUntilDeadline({ timestamp: '2026-09-05T15:00:00+02:00' }, MAX, now).deadline, '2026-09-05T13:00:00.000Z')
})

test('parkDeadlineError guards the mechanism against any caller', () => {
  const now = Date.parse('2026-09-05T12:00:00Z')
  assert.equal(parkDeadlineError(undefined, MAX, now), null)
  assert.equal(parkDeadlineError(null, MAX, now), null)
  assert.equal(parkDeadlineError('2026-09-05T12:00:01Z', MAX, now), null)
  assert.equal(parkDeadlineError('2026-09-05T18:00:59Z', MAX, now), null, 'a minute of slack past the cap')
  assert.match(parkDeadlineError('2026-09-05T18:01:01Z', MAX, now), /exceeds the 21600s cap/)
  assert.match(parkDeadlineError('2026-09-05T12:00:00Z', MAX, now), /in the past/)
  assert.match(parkDeadlineError('2020-01-01T00:00:00Z', MAX, now), /in the past/)
  assert.match(parkDeadlineError('nope', MAX, now), /not an ISO-8601 timestamp/)
  assert.match(parkDeadlineError(42, MAX, now), /not an ISO-8601 timestamp/)
})

test('runSleep parks with the canonical payload, deadline and wake text', async () => {
  const parks = []
  const before = Date.now()
  const o = await runSleep({ ending: false }, helpers(parks), { seconds: 30 })
  assert.equal(parks.length, 1)
  assert.equal(parks[0].kind, 'timer')
  assert.deepEqual(parks[0].payload, { seconds: 30 })
  const at = Date.parse(parks[0].deadline)
  assert.ok(at >= before + 30_000 && at <= Date.now() + 30_000, parks[0].deadline)
  assert.match(o.result.content[0].text, /^Woke up: slept 30s \(until .*\)\. Continue the task\.$/)
})

test('runSleep and runSleepUntil refuse an ending session and reject bad input before any park', async () => {
  const parks = []
  assert.deepEqual(await runSleep({ ending: true }, helpers(parks), { seconds: 5 }), { error: ENDING, ending: true })
  assert.deepEqual(await runSleepUntil({ ending: true }, helpers(parks), { timestamp: '2099-01-01T00:00:00Z' }), { error: ENDING, ending: true })
  for (const v of BAD_SECONDS) assert.ok((await runSleep({ ending: false }, helpers(parks), { seconds: v })).error, JSON.stringify(v))
  assert.ok((await runSleepUntil({ ending: false }, helpers(parks), { timestamp: 'nope' })).error)
  assert.ok((await runSleepUntil({ ending: false }, helpers(parks), { timestamp: new Date(Date.now() + (MAX + 60) * 1000).toISOString() })).error)
  assert.match((await runSleepUntil({ ending: false }, helpers(parks), { timestamp: '2020-01-01T00:00:00Z' })).text, /already passed/)
  assert.equal(parks.length, 0, 'nothing may park on refusal or rejection')
})

// Conformance: the same input through every harness adapter yields the same
// verdict, the same park row and the same wake text. Claude's adapter is the
// same dispatcher behind a Zod schema that already enforces the bounds.
function adapters(parks, { spec, message = '' } = {}) {
  const s = { ending: false, ...(spec ? { spec } : {}) }
  const h = helpers(parks, MAX, message)
  const codex = Object.fromEntries(buildCodexRunTools(s, h, spec).map((t) => [t.spec.name.replace('zwrm__platform__', ''), (args) => t.run(args)]))
  const pi = Object.fromEntries(buildPiRunTools(s, h, spec).map((t) => [t.name, (args) => t.execute('id', args)]))
  const viaHTTP = (name) => async (args) => {
    const r = await handlePlatformTool(s, h, name, args)
    if (r.status !== 200) throw new Error(r.body.error)
    return r.body.text
  }
  const opencode = Object.fromEntries(platformToolNames(spec).map((name) => [name, viaHTTP(name)]))
  return { codex, pi, opencode }
}

test('every harness rejects the same sleep inputs and none of them parks', async () => {
  for (const v of BAD_SECONDS) {
    const parks = []
    for (const [name, a] of Object.entries(adapters(parks))) {
      await assert.rejects(() => a.sleep({ seconds: v }), /integer between 1 and 21600/, `${name} ${JSON.stringify(v)}`)
    }
    assert.equal(parks.length, 0, JSON.stringify(v))
  }
})

test('every harness parks the same accepted sleep with the same wake text', async () => {
  for (const v of GOOD_SECONDS) {
    const parks = []
    const texts = []
    for (const a of Object.values(adapters(parks))) texts.push(textOf(await a.sleep({ seconds: v })))
    assert.equal(parks.length, 3)
    for (const p of parks) {
      assert.equal(p.kind, 'timer')
      assert.deepEqual(p.payload, { seconds: v })
    }
    assert.equal(new Set(parks.map((p) => p.deadline.slice(0, 16))).size, 1, 'deadlines agree to the minute')
    for (const t of texts) assert.match(t, new RegExp(`^Woke up: slept ${v}s \\(until .*\\)\\. Continue the task\\.$`))
  }
})

test('every harness applies the same timestamp rules for sleep_until', async () => {
  const parks = []
  const a = adapters(parks)
  const soon = new Date(Date.now() + 60_000).toISOString()
  const far = new Date(Date.now() + (MAX + 60) * 1000).toISOString()
  for (const [name, x] of Object.entries(a)) {
    await assert.rejects(() => x.sleep_until({ timestamp: 'nope' }), /invalid timestamp/, name)
    await assert.rejects(() => x.sleep_until({ timestamp: soon.replace('Z', '') }), /invalid timestamp/, `${name}: offset-less`)
    await assert.rejects(() => x.sleep_until({ timestamp: far }), /capped at 21600 seconds/, name)
    assert.match(textOf(await x.sleep_until({ timestamp: '2020-01-01T00:00:00Z' })), /already passed/, name)
  }
  assert.equal(parks.length, 0)
  for (const x of Object.values(a)) assert.match(textOf(await x.sleep_until({ timestamp: soon })), /Woke up at the requested time/)
  assert.equal(parks.length, 3)
  for (const p of parks) assert.deepEqual(p.payload, { timestamp: soon })
})

// textOf reads the text out of each harness's envelope: codex's tool
// response, pi's content array, or opencode's plain string.
function textOf(r) {
  if (typeof r === 'string') return r
  if (Array.isArray(r?.contentItems)) return r.contentItems.map((c) => c.text).join('\n')
  if (Array.isArray(r?.content)) return r.content.map((c) => c.text).join('\n')
  return JSON.stringify(r)
}

// ---- wait_for_task (#1911) ---------------------------------------------------

const RUN = { interactive: false }
const RUN_TASKS = { interactive: false, task_waits: true }
const CHAT = { interactive: true }
const CHAT_TASKS = { interactive: true, task_waits: true }

test('the spec gate: runs get the sleep tools, task_waits adds wait_for_task, chats never sleep', () => {
  assert.deepEqual(platformToolNames(RUN), ['sleep', 'sleep_until'])
  assert.deepEqual(platformToolNames(RUN_TASKS), ['sleep', 'sleep_until', 'wait_for_task'])
  assert.deepEqual(platformToolNames(CHAT), [])
  assert.deepEqual(platformToolNames(CHAT_TASKS), ['wait_for_task'])
  // Absent means a run without task_waits: the pre-#1911 shape.
  assert.deepEqual(platformToolNames(undefined), ['sleep', 'sleep_until'])
  // Only a real true opens it.
  assert.deepEqual(platformToolNames({ interactive: true, task_waits: 'yes' }), [])
  assert.deepEqual(platformToolNames(CHAT_TASKS, 'mcp__platform__'), ['mcp__platform__wait_for_task'])
})

test('the wait_for_task text states the cap in seconds and hours', () => {
  assert.equal(WAIT_FOR_TASK_DESCRIPTION(21600),
    'Wait here for a task you asked another agent for with delegate. Your turn pauses (the VM sleeps meanwhile, at no cost) until the task finishes, its agent asks you a question, or the timeout passes (at most 21600 seconds = 6 hours). It resumes here with what happened. Use it when you can\'t go on without the result; otherwise carry on or end your turn, and the result comes as a platform message.')
  assert.match(WAIT_FOR_TASK_DESCRIPTION(3600), /at most 3600 seconds = 1 hour\)/)
})

const GOOD_IDS = ['task_0b6f7c1e-8a2d-4c3b-9e5f-1a2b3c4d5e6f', 'task_a', `task_${'a'.repeat(64)}`]
const BAD_IDS = [undefined, null, '', 'task_', 'task', 'tsk_abc', 'TASK_abc', ' task_abc', 'task_abc ', 'task_a/b', 'task_a_b',
  `task_${'a'.repeat(65)}`, 'task_abc\n', 42, ['task_abc'], { id: 'task_abc' }]
const BAD_TIMEOUTS = [null, 0, -1, 1.5, MAX + 1, '60', NaN, Infinity, {}]

test('waitForTaskArgs takes the id delegate returned and an optional whole-second timeout, without coercion', () => {
  for (const id of GOOD_IDS) assert.deepEqual(waitForTaskArgs({ id }, MAX), { id, seconds: MAX }, id)
  for (const id of BAD_IDS) {
    assert.equal(waitForTaskArgs({ id }, MAX).error, 'id must be the task id delegate returned, like task_<uuid>', JSON.stringify(id))
  }
  assert.ok(waitForTaskArgs(undefined, MAX).error)
  for (const t of [1, 60, MAX]) assert.deepEqual(waitForTaskArgs({ id: 'task_x', timeout_seconds: t }, MAX), { id: 'task_x', seconds: t })
  for (const t of BAD_TIMEOUTS) {
    assert.equal(waitForTaskArgs({ id: 'task_x', timeout_seconds: t }, MAX).error,
      'timeout_seconds must be an integer between 1 and 21600', JSON.stringify(t))
  }
})

test('runWaitForTask parks a task park with the task, the timeout and its deadline', async () => {
  for (const [args, seconds] of [[{ id: 'task_abc' }, MAX], [{ id: 'task_abc', timeout_seconds: 90 }, 90]]) {
    const parks = []
    const before = Date.now()
    await runWaitForTask({ ending: false }, helpers(parks), args)
    assert.equal(parks.length, 1)
    assert.equal(parks[0].kind, 'task')
    assert.deepEqual(parks[0].payload, { task_id: 'task_abc', seconds })
    const at = Date.parse(parks[0].deadline)
    assert.ok(at >= before + seconds * 1000 && at <= Date.now() + seconds * 1000, parks[0].deadline)
    assert.equal(parkDeadlineError(parks[0].deadline, MAX), null, 'the mechanism guard accepts the deadline')
  }
})

test('a session holds at most MAX_TASK_WAITS waits at once; sleeps don\'t count', async () => {
  const held = new Map([['p-sleep', { kind: 'timer' }]])
  for (let i = 0; i < MAX_TASK_WAITS; i++) held.set(`p-${i}`, { kind: 'task' })
  const parks = []
  const o = await runWaitForTask({ ending: false, parks: held }, helpers(parks), { id: 'task_abc' })
  assert.match(o.error, /at most 4 waits at once/)
  assert.equal(parks.length, 0, 'nothing parked')
  held.delete('p-0')
  await runWaitForTask({ ending: false, parks: held }, helpers(parks), { id: 'task_abc' })
  assert.equal(parks.length, 1)
})

test('a resolved wait returns the control plane\'s text; a deadline wake says the task still runs', async () => {
  const told = 'Task task_abc (finance) finished: the VAT ID is fixed.'
  const done = await runWaitForTask({ ending: false }, helpers([], MAX, told), { id: 'task_abc' })
  assert.equal(done.result.content[0].text, told, 'the full tool text, nothing added')

  const timedOut = await runWaitForTask({ ending: false }, helpers([]), { id: 'task_abc', timeout_seconds: 90 })
  assert.equal(timedOut.result.content[0].text,
    'Stopped waiting after 90s: the task is still running. Its result will come into this conversation as a platform message when it finishes; task_status shows how it is going. Carry on, or end your turn.')
  assert.equal(stillRunningText(90), timedOut.result.content[0].text)
})

test('runWaitForTask refuses an ending session and bad input before any park', async () => {
  const parks = []
  assert.deepEqual(await runWaitForTask({ ending: true }, helpers(parks), { id: 'task_abc' }), { error: ENDING_WAIT, ending: true })
  for (const id of BAD_IDS) assert.ok((await runWaitForTask({ ending: false }, helpers(parks), { id })).error, JSON.stringify(id))
  for (const t of BAD_TIMEOUTS) assert.ok((await runWaitForTask({ ending: false }, helpers(parks), { id: 'task_abc', timeout_seconds: t })).error)
  assert.equal(parks.length, 0, 'nothing may park on refusal or rejection')
})

test('every harness gives a session exactly the platform tools its spec allows', () => {
  for (const spec of [RUN, RUN_TASKS, CHAT, CHAT_TASKS]) {
    const want = platformToolNames(spec)
    for (const [name, a] of Object.entries(adapters([], { spec }))) {
      assert.deepEqual(Object.keys(a), want, `${name} ${JSON.stringify(spec)}`)
    }
  }
})

test('the opencode endpoint refuses a tool the session was not given', async () => {
  // A run's tool dir bakes wait_for_task's file for every run, and the
  // bearer sits in the harness's environment: the spec gate holds here too.
  const h = helpers([])
  for (const [spec, name] of [[RUN, 'wait_for_task'], [CHAT, 'sleep'], [CHAT_TASKS, 'sleep'], [CHAT_TASKS, 'sleep_until'], [CHAT, 'wait_for_task']]) {
    const r = await handlePlatformTool({ ending: false, spec }, h, name, name === 'wait_for_task' ? { id: 'task_abc' } : { seconds: 5 })
    assert.equal(r.status, 404, `${name} ${JSON.stringify(spec)}`)
  }
})

test('every harness rejects the same wait_for_task inputs and none of them parks', async () => {
  for (const args of [...BAD_IDS.map((id) => ({ id })), ...BAD_TIMEOUTS.map((t) => ({ id: 'task_abc', timeout_seconds: t }))]) {
    for (const spec of [RUN_TASKS, CHAT_TASKS]) {
      const parks = []
      for (const [name, a] of Object.entries(adapters(parks, { spec }))) {
        await assert.rejects(() => a.wait_for_task(args), /id must be the task id|timeout_seconds must be an integer/, `${name} ${JSON.stringify(args)}`)
      }
      assert.equal(parks.length, 0, JSON.stringify(args))
    }
  }
})

test('every harness parks the same wait with the same text, in runs and chats', async () => {
  for (const spec of [RUN_TASKS, CHAT_TASKS]) {
    for (const message of ['', 'Task task_abc asks: which invoice?']) {
      const parks = []
      const texts = []
      for (const a of Object.values(adapters(parks, { spec, message }))) texts.push(textOf(await a.wait_for_task({ id: 'task_abc', timeout_seconds: 120 })))
      assert.equal(parks.length, 3)
      for (const p of parks) {
        assert.equal(p.kind, 'task')
        assert.deepEqual(p.payload, { task_id: 'task_abc', seconds: 120 })
      }
      assert.equal(new Set(parks.map((p) => p.deadline.slice(0, 16))).size, 1, 'deadlines agree to the minute')
      for (const t of texts) assert.equal(t, message || stillRunningText(120))
    }
  }
})

test('a cancelled sleep keeps its text and resolution exactly', () => {
  // Pinned byte for byte: the control plane stores the resolution, and the
  // text is what tells a resumed turn to stop.
  assert.deepEqual(parkCancellation('timer', 'interrupted'), {
    resolution: 'interrupted; sleep aborted',
    text: 'Sleep aborted: interrupted; sleep aborted. Do not start new work — stop now, with at most a one-line note of where you left off.',
  })
  for (const reason of ['session ended', 'session event delivery stopped', 'daemon shutting down']) {
    const c = parkCancellation('timer', reason)
    assert.equal(c.resolution, `${reason}; sleep aborted`)
    assert.equal(c.text, `Sleep aborted: ${reason}; sleep aborted. Do not start new work — stop now, with at most a one-line note of where you left off.`)
  }
})

test('a cancelled task wait says the task keeps running and its result comes later', () => {
  for (const reason of ['interrupted', 'session ended', 'session event delivery stopped', 'daemon shutting down', NEW_MESSAGE]) {
    const c = parkCancellation('task', reason)
    assert.equal(c.text, `Stopped waiting: ${reason}. The task keeps running; its result will come into this conversation as a platform message.`)
    assert.equal(c.resolution, `${reason}; wait stopped`)
    assert.doesNotMatch(c.text, /Sleep aborted|stop now/)
  }
  assert.equal(parkCancellation('task', NEW_MESSAGE).text,
    'Stopped waiting: a new message came in. The task keeps running; its result will come into this conversation as a platform message.')
})

test('a member\'s message cancels task parks only; an interrupt cancels both kinds', () => {
  const parks = new Map([
    ['p-timer', { kind: 'timer' }],
    ['p-task', { kind: 'task' }],
    ['p-task-2', { kind: 'task' }],
  ])
  const onMessage = parkCancellations(parks, NEW_MESSAGE, NEW_MESSAGE_CANCELS)
  assert.deepEqual(onMessage.map((c) => c.parkId), ['p-task', 'p-task-2'], 'the sleep is the run\'s own plan and stays')
  assert.ok(onMessage.every((c) => c.text.startsWith('Stopped waiting: a new message came in.')))

  const onInterrupt = parkCancellations(parks, 'interrupted')
  assert.deepEqual(onInterrupt.map((c) => c.parkId), ['p-timer', 'p-task', 'p-task-2'])
  assert.equal(onInterrupt[0].text, parkCancellation('timer', 'interrupted').text)
  assert.equal(onInterrupt[1].text, parkCancellation('task', 'interrupted').text)
  assert.deepEqual(parkCancellations(new Map(), 'interrupted'), [])
})
