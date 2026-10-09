// Driver-level tests for the claude harness's turn state machine, against a
// fake SDK query (the createClaudeDriver startQuery seam). No CLI, no
// network, no VM. The fake plays the CLI's side of the stream-json wire: it
// pulls prompts from the driver's input like the SDK's eager pump does, and
// the test scripts the messages the CLI would send back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLAUDE_SESSION_ENV, createClaudeDriver } from '../drivers/claude.mjs'
import { TurnEventContext } from '../turn-events.mjs'
import { createTaskLedger, levelTaskTtlMs } from '../drivers/claude-tasks.mjs'

const GRACE_MS = 100

// fakeQuery stands in for the SDK's query(): the driver iterates it for CLI
// messages; send() delivers one, end() closes the stream.
function fakeQuery() {
  const fake = { prompts: [], inbox: [], waiters: [], done: false }
  fake.send = (msg) => {
    const w = fake.waiters.shift()
    if (w) w({ value: msg, done: false })
    else fake.inbox.push(msg)
  }
  fake.end = () => {
    fake.done = true
    for (const w of fake.waiters.splice(0)) w({ value: undefined, done: true })
  }
  fake.startQuery = ({ prompt, options }) => {
    fake.options = options
    ;(async () => {
      for await (const item of prompt) fake.prompts.push(item)
    })()
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (fake.inbox.length) return Promise.resolve({ value: fake.inbox.shift(), done: false })
            if (fake.done) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => fake.waiters.push(resolve))
          },
        }
      },
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => ({}),
    }
  }
  return fake
}

// newHarness mirrors the turn boundaries server.mjs's setState draws (begin
// before a working status, complete on idle) over the real TurnEventContext,
// and stamps events the way EventPusher does. Hooks run on every emit, so a
// test can act at an exact point in the stream instead of racing a timer.
function newHarness() {
  const events = []
  const hooks = []
  let n = 0
  const turns = new TurnEventContext(() => `turn-${++n}`)
  const emit = (type, payload, opts = {}) => {
    const turnId = Object.hasOwn(opts, 'turnId') ? opts.turnId : turns.implicitEventTurnId(type)
    const ev = { type, payload, turnId, at: performance.now() }
    events.push(ev)
    for (const hook of hooks) hook(ev)
  }
  const s = {
    id: 'sess-1',
    state: 'idle',
    harness: 'claude',
    sdkSessionId: null,
    pending: new Map(),
    parks: new Map(),
    backgroundTasks: createTaskLedger(),
    pusher: { emit, turns },
    lastResult: null,
    ending: false,
  }
  const h = {
    log: () => {},
    syncToDisk: async () => {},
    setState: (sess, state, extra = {}) => {
      if (state === 'working' && !turns.activeTurnId) {
        const started = turns.begin('claude')
        emit('turn.started', started.payload, { turnId: started.turnId })
      }
      if (state === 'idle' && turns.activeTurnId) {
        const completed = turns.complete('completed')
        emit('turn.completed', completed.payload, { turnId: completed.turnId })
      }
      if (sess.state === state) return
      sess.state = state
      emit('session.status', { state, ...extra })
    },
    rotateTurn: () => {},
    isTurnDraining: () => turns.drainingTurnId !== null,
    resumeIfUnblocked: () => {},
    isEscalatedTool: () => false,
    VERSION: '0.0.0-test',
    MAX_SLEEP_SECONDS: 3600,
  }
  return { s, h, events, hooks }
}

function build(spec = {}) {
  process.env.ZWRM_CLAUDE_BIN = process.execPath
  const fake = fakeQuery()
  const { s, h, events, hooks } = newHarness()
  const driver = createClaudeDriver(s, { interactive: true, cwd: process.cwd(), ...spec }, h, {
    startQuery: fake.startQuery,
    drainGraceMs: GRACE_MS,
  })
  s.driver = driver
  driver.start()
  return { s, driver, fake, events, hooks }
}

async function until(events, pred, what, timeoutMS = 2000) {
  const deadline = Date.now() + timeoutMS
  while (Date.now() < deadline) {
    if (pred(events)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail(`timed out waiting for ${what}; got: ${events.map((e) => e.type).join(', ')}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const statuses = (events) => events.filter((e) => e.type === 'session.status').map((e) => e.payload)
const isInit = (e) => e.type === 'sdk.system' && e.payload.subtype === 'init'
const isNotification = (e) => e.type === 'sdk.system' && e.payload.subtype === 'task_notification'
// Node may fire a timer up to a millisecond early.
const assertWaitedGrace = (from, to, what) =>
  assert.ok(to.at - from.at >= GRACE_MS - 2, `${what} after ${Math.round(to.at - from.at)} ms, inside the ${GRACE_MS} ms grace`)
const isResult = (e) => e.type === 'sdk.result'

const init = { type: 'system', subtype: 'init', session_id: 'cli-1' }
const assistant = (text) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } })
const result = { type: 'result', subtype: 'success', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} }

// A prompted turn that leaves one background shell running, ending idle
// with the count the CP defers run completion on.
async function turnLeavingBackgroundTask(driver, fake, events) {
  driver.queueMessage('start a poll in the background')
  fake.send(init)
  fake.send({ type: 'system', subtype: 'task_started', task_id: 'bg-1', description: 'poll' })
  fake.send(result)
  await until(events, (ev) => ev.some((e) => e.type === 'turn.completed'), 'the prompted turn to end')
  assert.deepEqual(statuses(events), [{ state: 'working' }, { state: 'idle', background_tasks: 1 }])
}

test('a turn the CLI starts on its own after a background task settles goes working and closes on its result (#1613)', async () => {
  const { s, driver, fake, events } = build()
  await turnLeavingBackgroundTask(driver, fake, events)
  const mark = events.length

  // The poll exits; the CLI settles the task, then wakes itself into a turn
  // to hand the notification to the model.
  fake.send({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } })
  fake.send({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' })
  fake.send(init)
  fake.send(assistant('the poll finished'))
  fake.send(result)
  await until(events, (ev) => ev.slice(mark).some((e) => e.type === 'turn.completed'), 'the self-started turn to end')

  const own = events.slice(mark)
  assert.deepEqual(statuses(own), [{ state: 'working' }, { state: 'idle', background_tasks: 0 }],
    'the turn goes working at its init and settles idle through setState, with no drain re-emit ahead of it')
  const started = own.find((e) => e.type === 'turn.started')
  assert.equal(started.turnId, 'turn-2', 'the self-started turn gets a fresh canonical turn')
  const initAt = own.findIndex(isInit)
  assert.ok(own.findIndex((e) => e.type === 'turn.started') < initAt, 'the turn opens before its init is emitted')
  for (const e of own.slice(initAt).filter((e) => e.type.startsWith('sdk.'))) {
    assert.equal(e.turnId, 'turn-2', `${e.type} must carry the self-started turn's id`)
  }
  assert.equal(own.find((e) => e.type === 'turn.completed').turnId, 'turn-2')
  assert.equal(s.state, 'idle')

  // The drain re-emit the settle armed was dropped when the turn started.
  const settled = events.length
  await sleep(GRACE_MS * 3)
  assert.deepEqual(events.slice(settled), [], 'nothing may be emitted after the turn settled')
  fake.end()
})

test('a settle no turn follows still re-announces idle with a zero count after the grace (#1251)', async () => {
  const { driver, fake, events } = build()
  await turnLeavingBackgroundTask(driver, fake, events)
  const mark = events.length

  fake.send({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' })
  await until(events, (ev) => statuses(ev.slice(mark)).length === 1, 'the drain re-emit')
  const reemit = events.slice(mark).find((e) => e.type === 'session.status')
  assert.deepEqual(reemit.payload, { state: 'idle', background_tasks: 0 })
  assert.equal(reemit.turnId, null, 'the re-emit belongs to no turn')
  assertWaitedGrace(events.slice(mark).find(isNotification), reemit, 'the zero went out')
  fake.end()
})

test('a prompt consumed during the grace drops the drain re-emit (#1613)', async () => {
  const { driver, fake, events, hooks } = build()
  await turnLeavingBackgroundTask(driver, fake, events)
  const mark = events.length

  // The prompt lands right after the settle armed the re-emit, before its
  // grace can run out.
  hooks.push((e) => { if (isNotification(e)) driver.queueMessage('next') })
  fake.send({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' })
  await until(events, (ev) => ev.slice(mark).some(isNotification), 'the settle')
  await sleep(GRACE_MS * 3)
  assert.deepEqual(statuses(events.slice(mark)), [{ state: 'working' }],
    'no idle may be announced under a live turn')
  fake.end()
})

test("a prompted turn's init does not open a second turn", async () => {
  const { driver, fake, events } = build()
  driver.queueMessage('hello')
  fake.send(init)
  fake.send(assistant('hi'))
  fake.send(result)
  await until(events, (ev) => ev.some(isResult) && ev.some((e) => e.type === 'turn.completed'), 'the turn to end')
  assert.equal(events.filter((e) => e.type === 'turn.started').length, 1)
  assert.deepEqual(statuses(events), [{ state: 'working' }, { state: 'idle', background_tasks: 0 }])
  assert.ok(events.filter((e) => e.type.startsWith('sdk.')).every((e) => e.turnId === 'turn-1'))
  fake.end()
})

test("a manual compaction's init leaves the session idle and opens no turn (#1553)", async () => {
  const { s, driver, fake, events } = build()
  const compacted = driver.compact({ instructions: 'keep the codeword' })
  await until(events, () => fake.prompts.length === 1, 'the compact command to reach the CLI')
  // The order of the #1601 trace: status before init before boundary.
  fake.send({ type: 'system', subtype: 'status', status: null, compact_result: 'success' })
  fake.send(init)
  fake.send({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 10, post_tokens: 2 } })
  fake.send(result)
  await compacted
  await until(events, (ev) => ev.some(isInit), 'the init')
  assert.equal(s.state, 'idle')
  assert.deepEqual(statuses(events), [], 'a compaction flips no status')
  assert.equal(events.filter((e) => e.type === 'turn.started').length, 0, 'a compaction is not a turn')
  assert.equal(events.filter(isResult).length, 0, "the compact command's result is consumed")
  fake.end()
})

// A turn whose background task settles while the model writes its final
// reply: the notification reaches the CLI mid-turn, and the CLI starts a turn
// for it right after the result (seen on 2.1.280, 7 ms after the result).
async function turnWithMidTurnSettle(driver, fake, events) {
  driver.queueMessage('start a job in the background, then write a story')
  fake.send(init)
  fake.send({ type: 'system', subtype: 'task_started', task_id: 'bg-1', description: 'job' })
  fake.send({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } })
  fake.send({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' })
  fake.send(assistant('a story'))
  fake.send(result)
  await until(events, (ev) => ev.some((e) => e.type === 'turn.completed'), 'the turn to end')
  assert.deepEqual(statuses(events), [{ state: 'working' }, { state: 'idle', background_tasks: 1 }],
    'the undelivered notification is reported as live work, so the CP does not complete the run on this idle')
}

test('a notification that arrives mid-turn holds run completion for the turn the CLI starts for it (#1613)', async () => {
  const { driver, fake, events } = build()
  await turnWithMidTurnSettle(driver, fake, events)
  const mark = events.length

  fake.send(init)
  fake.send(assistant('noticed'))
  fake.send(result)
  await until(events, (ev) => ev.slice(mark).some((e) => e.type === 'turn.completed'), 'the self-started turn to end')
  assert.deepEqual(statuses(events.slice(mark)), [{ state: 'working' }, { state: 'idle', background_tasks: 0 }])
  const settled = events.length
  await sleep(GRACE_MS * 3)
  assert.deepEqual(events.slice(settled), [], 'the held zero was dropped when the turn started')
  fake.end()
})

test('a notification that arrives mid-turn with no turn after it releases the zero after the grace (#1613)', async () => {
  const { driver, fake, events } = build()
  await turnWithMidTurnSettle(driver, fake, events)
  const idle = events.findLast((e) => e.type === 'session.status')
  await until(events, (ev) => statuses(ev).length === 3, 'the drain re-emit')
  const reemit = events.findLast((e) => e.type === 'session.status')
  assert.deepEqual(reemit.payload, { state: 'idle', background_tasks: 0 })
  assertWaitedGrace(idle, reemit, 'the zero went out')
  fake.end()
})

// The same turn on a CLI that sends the level (#1712): the level confirms
// the shell; a foreground task's started edge, which the level never lists,
// does not count even though it has not settled by the result.
async function turnLeavingLevelTask(driver, fake, events) {
  driver.queueMessage('start a dev server in the background')
  fake.send(init)
  fake.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-1', task_type: 'local_bash', description: 'dev server' }] })
  fake.send({ type: 'system', subtype: 'task_started', task_id: 'bg-1', is_backgrounded: true })
  fake.send({ type: 'system', subtype: 'task_started', task_id: 'fg-1', is_backgrounded: false })
  fake.send(result)
  await until(events, (ev) => ev.some((e) => e.type === 'turn.completed'), 'the prompted turn to end')
  assert.deepEqual(statuses(events), [{ state: 'working' }, { state: 'idle', background_tasks: 1 }])
}

test('the level reports the background count at the end of a turn (#1712)', async () => {
  const { s, driver, fake, events } = build()
  await turnLeavingLevelTask(driver, fake, events)
  assert.equal(s.backgroundTasks.level, true)
  fake.end()
})

test("the ledger's level TTL follows the CLI's shell ceiling, including a raised one (#1712)", () => {
  const { s, fake } = build()
  assert.equal(s.backgroundTasks.levelTtlMs, levelTaskTtlMs(fake.options.env))
  assert.equal(levelTaskTtlMs(CLAUDE_SESSION_ENV), 25 * 60 * 60 * 1000, 'the 24 h default')
  fake.end()
  const raised = build({ env: { BASH_MAX_TIMEOUT_MS: String(48 * 60 * 60 * 1000) } })
  assert.equal(raised.s.backgroundTasks.levelTtlMs, 49 * 60 * 60 * 1000)
  raised.fake.end()
})

test('under the level, a task that settles mid-turn is still owed to the result (#1712, #1613)', async () => {
  const { driver, fake, events } = build()
  driver.queueMessage('start a job in the background, then write a story')
  fake.send(init)
  fake.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-1', task_type: 'local_bash', description: 'job' }] })
  fake.send({ type: 'system', subtype: 'task_started', task_id: 'bg-1', is_backgrounded: true })
  fake.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  fake.send({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } })
  fake.send({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' })
  fake.send(assistant('a story'))
  fake.send(result)
  await until(events, (ev) => ev.some((e) => e.type === 'turn.completed'), 'the turn to end')
  assert.deepEqual(statuses(events), [{ state: 'working' }, { state: 'idle', background_tasks: 1 }],
    'live 0 + owed 1: the CP must not complete the run on this idle')
  const mark = events.length
  fake.send(init)
  fake.send(assistant('noticed'))
  fake.send(result)
  await until(events, (ev) => ev.slice(mark).some((e) => e.type === 'turn.completed'), 'the self-started turn to end')
  assert.deepEqual(statuses(events.slice(mark)), [{ state: 'working' }, { state: 'idle', background_tasks: 0 }])
  const settled = events.length
  await sleep(GRACE_MS * 3)
  assert.deepEqual(events.slice(settled), [], 'the held zero was dropped when the turn started')
  fake.end()
})

test('under the level, a live task and an owed one both hold the idle count (#1712, #1613)', async () => {
  const { driver, fake, events } = build()
  const lvl = (...ids) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: id })) })
  driver.queueMessage('start two background jobs')
  fake.send(init)
  fake.send(lvl('a', 'b'))
  fake.send(lvl('a'))
  fake.send({ type: 'system', subtype: 'task_notification', task_id: 'b', status: 'completed' })
  fake.send(result)
  await until(events, (ev) => ev.some((e) => e.type === 'turn.completed'), 'the turn to end')
  assert.deepEqual(statuses(events), [{ state: 'working' }, { state: 'idle', background_tasks: 2 }])
  const mark = events.length
  fake.send(init)
  fake.send(assistant('b finished'))
  fake.send(result)
  await until(events, (ev) => ev.slice(mark).some((e) => e.type === 'turn.completed'), 'the self-started turn to end')
  assert.deepEqual(statuses(events.slice(mark)), [{ state: 'working' }, { state: 'idle', background_tasks: 1 }])
  await sleep(GRACE_MS * 3)
  assert.equal(statuses(events.slice(mark)).length, 2, 'no zero while a is live')
  fake.end()
})

test('a level that drains while idle re-announces idle with a zero count after the grace (#1712)', async () => {
  const { driver, fake, events } = build()
  await turnLeavingLevelTask(driver, fake, events)
  const mark = events.length

  // 2.1.289 order on a kill: the level leads the settle edges.
  fake.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  fake.send({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'killed' } })
  fake.send({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'stopped' })
  await until(events, (ev) => statuses(ev.slice(mark)).length === 1, 'the drain re-emit')
  const own = events.slice(mark)
  const reemit = own.find((e) => e.type === 'session.status')
  assert.deepEqual(reemit.payload, { state: 'idle', background_tasks: 0 })
  const drained = own.find((e) => e.type === 'sdk.system' && e.payload.subtype === 'background_tasks_changed')
  assertWaitedGrace(drained, reemit, 'the zero went out')
  await sleep(GRACE_MS * 3)
  assert.equal(statuses(events.slice(mark)).length, 1, 'a single re-emit')
  fake.end()
})

test('an init while an interrupt drains opens no turn', async () => {
  // handleInterrupt retires the turn before the driver interrupts and clears
  // the drain only after the driver returns; an init inside that window is
  // the aborted turn's, and a result landing there skips the idle flip.
  const { s, driver, fake, events, hooks } = build()
  driver.queueMessage('go')
  fake.send(init)
  await until(events, (ev) => ev.some(isInit), 'the turn to start')
  hooks.push((e) => {
    if (e.type === 'session.status' && e.payload.state === 'idle') fake.send(init)
  })
  const draining = s.pusher.turns.startDraining('interrupted')
  await driver.interrupt()
  await until(events, (ev) => ev.filter(isInit).length === 2, 'the late init')
  s.pusher.turns.finishDraining(draining)
  assert.equal(s.state, 'idle')
  assert.deepEqual(statuses(events), [{ state: 'working' }, { state: 'idle', background_tasks: 0 }])
  assert.equal(events.filter((e) => e.type === 'turn.started').length, 1)
  fake.end()
})

test('sessions get the todo-tool and background-shell defaults; the VM env and the spec override them (#1698, #1702)', () => {
  process.env.ZWRM_CLAUDE_BIN = process.execPath
  // Hermetic: a host (or an agentd session running this suite) may export
  // these already.
  const keys = Object.keys(CLAUDE_SESSION_ENV)
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  for (const k of keys) delete process.env[k]
  process.env.BASH_MAX_TIMEOUT_MS = '3600000'
  try {
    const fake = fakeQuery()
    const { s, h } = newHarness()
    const spec = { interactive: true, cwd: process.cwd(), env: { CLAUDE_CODE_ENABLE_TASKS: '1' } }
    s.driver = createClaudeDriver(s, spec, h, { startQuery: fake.startQuery, drainGraceMs: GRACE_MS })
    s.driver.start()
    const env = fake.options.env
    assert.equal(env.CLAUDE_CODE_ENABLE_TODO_TOOLS, '1')
    assert.equal(env.CLAUDE_CODE_ENABLE_TASKS, '1', 'the session spec wins')
    assert.equal(env.BASH_MAX_TIMEOUT_MS, '3600000', 'the VM environment wins')
    assert.equal(env.ZWRM_CLAUDE_BIN, process.execPath, 'the VM environment still reaches the CLI')
    fake.end()
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
  assert.deepEqual(CLAUDE_SESSION_ENV, {
    CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    CLAUDE_CODE_ENABLE_TASKS: '0',
    BASH_MAX_TIMEOUT_MS: '86400000',
  })
})

test('the first init without TodoWrite is logged once (#1698)', async () => {
  process.env.ZWRM_CLAUDE_BIN = process.execPath
  const fake = fakeQuery()
  const { s, h, events } = newHarness()
  const logs = []
  h.log = (...args) => logs.push(args.join(' '))
  s.driver = createClaudeDriver(s, { interactive: true, cwd: process.cwd() }, h, {
    startQuery: fake.startQuery,
    drainGraceMs: GRACE_MS,
  })
  s.driver.start()
  const bare = { type: 'system', subtype: 'init', session_id: 'sdk-1', claude_code_version: '9.9.9', tools: ['Bash', 'TaskCreate'] }
  fake.send(bare)
  fake.send({ ...bare })
  await until(events, (ev) => ev.filter(isInit).length === 2, 'both inits')
  assert.deepEqual(logs.filter((l) => l.includes('TodoWrite')), [
    "warning: claude 9.9.9 offers no TodoWrite tool; the session's todo list will stay empty",
  ])
  fake.end()
})

test('an init that offers TodoWrite logs nothing about it (#1698)', async () => {
  process.env.ZWRM_CLAUDE_BIN = process.execPath
  const fake = fakeQuery()
  const { s, h, events } = newHarness()
  const logs = []
  h.log = (...args) => logs.push(args.join(' '))
  s.driver = createClaudeDriver(s, { interactive: true, cwd: process.cwd() }, h, {
    startQuery: fake.startQuery,
    drainGraceMs: GRACE_MS,
  })
  s.driver.start()
  fake.send({ type: 'system', subtype: 'init', session_id: 'sdk-1', tools: ['Bash', 'TodoWrite'] })
  await until(events, (ev) => ev.some(isInit), 'the init')
  assert.equal(logs.filter((l) => l.includes('TodoWrite')).length, 0)
  fake.end()
})
