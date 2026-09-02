// Driver-level tests for the opencode harness (#1391), against the validating
// fake server (test/fake-opencode-server.mjs). No binary, no network beyond
// loopback, no VM. These cover what the pure translators cannot: the turn
// state machine, the ask gate wired to the shared pending map, the
// exactly-one-result contract, interrupt semantics, resume self-heal, and the
// pre-#1392 connector refusal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenCodeDriver } from '../drivers/opencode.mjs'
import { startFakeOpenCode } from './fake-opencode-server.mjs'

function newHarness({ spec = {} } = {}) {
  const events = []
  const s = {
    id: 'sess-1',
    state: 'starting',
    harness: 'opencode',
    sdkSessionId: null,
    pending: new Map(),
    parks: new Map(),
    pusher: { emit: (type, payload, opts) => events.push({ type, payload, ephemeral: !!opts?.ephemeral }) },
    lastResult: null,
    ending: false,
    driver: null,
  }
  const h = {
    log: () => {},
    syncToDisk: async () => { events.push({ type: '__sync' }) },
    setState: (sess, state) => {
      if (sess.state === state) return
      sess.state = state
      events.push({ type: 'session.status', payload: { state } })
    },
    isDone: (sess) => sess.state === 'ended' || sess.state === 'error',
    cancelPendingPermissions: (sess, message) => {
      for (const [id, p] of sess.pending) {
        sess.pending.delete(id)
        events.push({ type: 'permission.decision', payload: { request_id: id, behavior: 'cancel', message } })
        p.resolve({ behavior: 'deny', message, interrupt: false })
      }
    },
    resumeIfUnblocked: () => {},
    isEscalatedTool: (name, servers) =>
      Array.isArray(servers) && servers.some((sl) => name === `mcp__${sl}` || name.startsWith(`mcp__${sl}__`)),
    VERSION: '0.9.0-test',
    MAX_SLEEP_SECONDS: 3600,
  }
  const fullSpec = {
    session_id: 'sess-1',
    cwd: process.cwd(),
    permission_mode: 'bypassPermissions',
    model: 'qwen-235b',
    ...spec,
  }
  return { s, h, spec: fullSpec, events }
}

async function build(fake, opts) {
  const ctx = opts ?? newHarness()
  ctx.spec.env = { ...(ctx.spec.env || {}), ZWRM_OPENCODE_URL: fake.url, OPENCODE_SERVER_PASSWORD: 'test' }
  const driver = await createOpenCodeDriver(ctx.s, ctx.spec, ctx.h)
  ctx.s.driver = driver
  return { ...ctx, driver }
}

async function until(events, pred, what, timeoutMS = 5000) {
  const deadline = Date.now() + timeoutMS
  while (Date.now() < deadline) {
    if (pred(events)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail(`timed out waiting for ${what}; got: ${events.map((e) => e.type).join(', ')}`)
}
const ofType = (events, t) => events.filter((e) => e.type === t)

test('construction creates a session, init carries the resume handle, prompts validate', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake)
    assert.match(s.sdkSessionId, /^ses_fake/)
    driver.start()
    const init = ofType(events, 'sdk.system')[0]
    assert.equal(init.payload.session_id, s.sdkSessionId)
    assert.equal(init.payload.harness, 'opencode')
    assert.equal(init.payload.model, 'qwen-235b')

    assert.equal(driver.queueMessage('do the thing'), true)
    await until(events, () => fake.state.prompts.length === 1, 'the prompt to land')
    assert.equal(fake.state.prompts[0].parts[0].text, 'do the thing')
    assert.equal(fake.state.prompts[0].model.modelID, 'qwen-235b')
    await driver.shutdownStop()
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('a successful turn emits text, exactly one result with cumulative cost, and idles', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake)
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId

    fake.emit('message.part.updated', { part: { id: 'prt1', sessionID: sid, type: 'text', text: 'hel' } })
    fake.emit('message.part.updated', { part: { id: 'prt1', sessionID: sid, type: 'text', text: 'hello world' } })
    fake.emit('message.updated', { info: { sessionID: sid, role: 'assistant', cost: 0.002, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 5, write: 1 } } } })
    fake.setSessionCost(sid, 0.002)
    fake.emit('session.idle', { sessionID: sid })

    await until(events, (ev) => ofType(ev, 'sdk.result').length === 1, 'the result')
    // Streaming: two ephemeral partials carrying the delta suffixes.
    const partials = ofType(events, 'sdk.partial')
    assert.equal(partials.length, 2)
    assert.equal(partials[0].payload.event.type, 'content_block_delta')
    assert.equal(partials[0].payload.event.delta.text, 'hel')
    assert.ok(partials.every((p) => p.ephemeral))
    // The full text message flushed at the turn boundary.
    const texts = ofType(events, 'sdk.assistant').filter((e) => e.payload.message.content[0].type === 'text')
    assert.equal(texts.length, 1)
    assert.equal(texts[0].payload.message.content[0].text, 'hello world')
    const result = ofType(events, 'sdk.result')[0].payload
    assert.equal(result.subtype, 'success')
    assert.equal(result.result, 'hello world')
    assert.equal(result.total_cost_usd, 0.002)
    assert.equal(result.usage.input_tokens, 100)
    assert.equal(result.usage.cache_creation_input_tokens, 1)
    assert.equal(s.state, 'idle')
    // A duplicate idle must not mint a second result.
    fake.emit('session.idle', { sessionID: sid })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(ofType(events, 'sdk.result').length, 1)
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('tool parts render as one tool_use / tool_result pair, foreign sessions are ignored', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake)
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId

    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'pending', input: {} } } })
    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running', input: { command: 'echo hi' } } } })
    // A subagent's traffic must not enter this transcript.
    fake.emit('message.part.updated', { part: { id: 'px', sessionID: 'ses_other', type: 'tool', tool: 'bash', callID: 'cx', state: { status: 'running', input: {} } } })
    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\n' } } })
    fake.emit('session.idle', { sessionID: sid })

    await until(events, (ev) => ofType(ev, 'sdk.result').length === 1, 'result')
    const uses = ofType(events, 'sdk.assistant').filter((e) => e.payload.message.content[0].type === 'tool_use')
    assert.equal(uses.length, 1)
    assert.equal(uses[0].payload.message.content[0].id, 'c1')
    assert.equal(uses[0].payload.message.content[0].name, 'bash')
    const results = ofType(events, 'sdk.user')
    assert.equal(results.length, 1)
    assert.equal(results[0].payload.message.content[0].tool_use_id, 'c1')
    assert.equal(results[0].payload.message.content[0].content, 'hi\n')
    assert.equal(results[0].payload.message.content[0].is_error, undefined)
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('a slow /event subscription does not lose the turn: prompt waits for it (#1429 race)', async () => {
  // opencode has no event replay; a prompt sent before the SSE attaches loses
  // the whole turn (observed on a cold VM as an empty result). The driver must
  // gate the first prompt on the subscription. Delay the fake's /event so a
  // fire-and-forget subscribe would lose the race.
  const fake = await startFakeOpenCode({ eventDelayMS: 400 })
  try {
    const ctx = newHarness()
    ctx.spec.env = { ZWRM_OPENCODE_URL: fake.url, OPENCODE_SERVER_PASSWORD: 'test' }
    const t0 = Date.now()
    const driver = await createOpenCodeDriver(ctx.s, ctx.spec, ctx.h)
    // Construction itself must not resolve before the stream attaches.
    assert.ok(Date.now() - t0 >= 380, 'createOpenCodeDriver returned before /event connected')
    ctx.s.driver = driver
    driver.start()
    driver.queueMessage('go')
    await until(ctx.events, () => fake.state.prompts.length === 1, 'the prompt')
    // The prompt landed only after the subscription — the invariant the fix
    // guarantees, so no message event can precede our listener.
    assert.ok(fake.state.firstPromptAt >= fake.state.subscribedAt,
      `prompt (${fake.state.firstPromptAt}) preceded subscription (${fake.state.subscribedAt})`)

    const sid = ctx.s.sdkSessionId
    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'text', text: 'hi there' } })
    fake.emit('message.updated', { info: { sessionID: sid, role: 'assistant', cost: 0.001, tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } })
    fake.setSessionCost(sid, 0.001)
    fake.emit('session.idle', { sessionID: sid })
    await until(ctx.events, (ev) => ofType(ev, 'sdk.result').length === 1, 'the result')
    assert.equal(ofType(ctx.events, 'sdk.result')[0].payload.result, 'hi there')
    await driver.shutdownStop()
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('a task tool_use that never idles trips the stall watchdog; child-session activity is logged (#1388)', async () => {
  process.env.ZWRM_OPENCODE_STALL_MS = '150'
  const fake = await startFakeOpenCode()
  try {
    const ctx = newHarness()
    const logs = []
    ctx.h.log = (m) => logs.push(String(m))
    const { s, driver, events } = await build(fake, ctx)
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'the prompt')
    const sid = s.sdkSessionId
    // A subagent's child-session event: dropped from the transcript but logged.
    fake.emit('message.part.updated', { part: { id: 'c1', sessionID: 'ses_child9', type: 'text', text: 'sub work' } })
    // The parent's task tool_use arms the watchdog; then we deliberately never
    // send session.idle — simulating the production wedge.
    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'tool', tool: 'task', callID: 't1', state: { status: 'running', input: {} } } })
    await until(events, (ev) => ev.some((x) => x.type === 'sdk.assistant' && x.payload?.message?.content?.[0]?.name === 'task'), 'task tool_use emitted')
    await new Promise((r) => setTimeout(r, 500))
    assert.ok(logs.some((m) => /SUBAGENT STALL WATCH/.test(m)), `watchdog did not fire; logs: ${logs.join(' | ')}`)
    assert.ok(logs.some((m) => /subagent child session ses_child9/.test(m)), 'child-session activity was not logged')
    const stall = logs.find((m) => /SUBAGENT STALL WATCH/.test(m))
    assert.match(stall, /childSessions=\[ses_child9\]/)
    fake.emit('session.idle', { sessionID: sid }) // close the turn to shut down cleanly
    await driver.shutdownStop()
    fake.assertNoViolations(assert)
  } finally {
    delete process.env.ZWRM_OPENCODE_STALL_MS
    await fake.close()
  }
})

test('a task turn that idles normally does NOT trip the watchdog (#1388)', async () => {
  process.env.ZWRM_OPENCODE_STALL_MS = '150'
  const fake = await startFakeOpenCode()
  try {
    const ctx = newHarness()
    const logs = []
    ctx.h.log = (m) => logs.push(String(m))
    const { s, driver, events } = await build(fake, ctx)
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'the prompt')
    const sid = s.sdkSessionId
    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'tool', tool: 'task', callID: 't1', state: { status: 'running', input: {} } } })
    // The subagent completes and the parent idles BEFORE the watch fires.
    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'tool', tool: 'task', callID: 't1', state: { status: 'completed', input: {}, output: 'done' } } })
    fake.emit('session.idle', { sessionID: sid })
    await until(events, (ev) => ofType(ev, 'sdk.result').length === 1, 'the result')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(logs.some((m) => /SUBAGENT STALL WATCH/.test(m)), false, `watchdog fired on a normal turn; logs: ${logs.join(' | ')}`)
    await driver.shutdownStop()
    fake.assertNoViolations(assert)
  } finally {
    delete process.env.ZWRM_OPENCODE_STALL_MS
    await fake.close()
  }
})

test('completed todowrite feeds the task list; errors and malformed input do not', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake)
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId

    const todos = [
      { id: 't1', content: 'write the fix', status: 'completed' },
      { id: 't2', content: 'run the tests', status: 'in_progress', priority: 'high' },
      { id: 't3', content: 'open the PR', status: 'made_up_status' },
    ]
    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'tool', tool: 'todowrite', callID: 'c1', state: { status: 'running', input: { todos } } } })
    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'tool', tool: 'todowrite', callID: 'c1', state: { status: 'completed', input: { todos }, output: 'ok' } } })
    // A rejected call never adopted a list.
    fake.emit('message.part.updated', { part: { id: 'p2', sessionID: sid, type: 'tool', tool: 'todowrite', callID: 'c2', state: { status: 'error', input: { todos: [{ content: 'never', status: 'pending' }] }, error: 'rejected' } } })
    // Malformed input is not an empty list.
    fake.emit('message.part.updated', { part: { id: 'p3', sessionID: sid, type: 'tool', tool: 'todowrite', callID: 'c3', state: { status: 'completed', input: { todos: 'not-a-list' }, output: 'ok' } } })
    fake.emit('session.idle', { sessionID: sid })

    await until(events, (ev) => ofType(ev, 'sdk.result').length === 1, 'result')
    const updates = ofType(events, 'todo.updated')
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].payload.todos, [
      { content: 'write the fix', status: 'completed' },
      { content: 'run the tests', status: 'in_progress', priority: 'high' },
      { content: 'open the PR', status: 'pending' },
    ])
    // The calls themselves still ride the transcript as tool pairs.
    assert.equal(ofType(events, 'sdk.user').length, 3)
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('listCommands normalizes the native command list', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { driver } = await build(fake)
    driver.start()
    const commands = await driver.listCommands()
    assert.deepEqual(commands, [
      { name: 'greet', description: 'Greets someone warmly', argument_hint: '$ARGUMENTS' },
      { name: 'noargs', description: 'No arguments', argument_hint: '' },
    ])
    // The template never crosses the daemon boundary.
    assert.equal(commands.some((c) => 'template' in c || 'source' in c), false)
    await driver.shutdownStop()
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('invokeCommand runs the native endpoint as a turn and releases exclusivity', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake)
    driver.start()
    // server.mjs reserves command admission before calling the driver.
    s.controlBusy = 'command'
    const queued = await driver.invokeCommand({ command: 'greet', arguments: 'Tom', model: '', pendingContext: [] })
    assert.deepEqual(queued, { command: 'greet', visible: '/greet Tom' })
    await until(events, () => fake.state.commandInvocations.length === 1, 'the command to land')
    const body = fake.state.commandInvocations[0]
    assert.equal(body.command, 'greet')
    assert.equal(body.arguments, 'Tom')
    // No per-call override: the session's model rides along, string form.
    assert.equal(body.model, 'zwrm/qwen-235b')
    assert.equal(s.state, 'working')

    const sid = s.sdkSessionId
    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'text', text: 'hello Tom' } })
    fake.emit('message.updated', { info: { sessionID: sid, role: 'assistant', cost: 0.001, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } })
    fake.setSessionCost(sid, 0.001)
    fake.emit('session.idle', { sessionID: sid })
    await until(events, (ev) => ofType(ev, 'sdk.result').length === 1, 'the command turn result')
    // The driver owns releasing the server's exclusive admission flag at the
    // turn boundary, like claude's finishCommandTurn.
    assert.equal(s.controlBusy, null)
    assert.equal(s.state, 'idle')
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('invokeCommand pre-resolves: unknown names 400 cleanly, never reach the server', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { driver } = await build(fake)
    driver.start()
    await assert.rejects(
      () => driver.invokeCommand({ command: 'nosuch', arguments: '', model: '', pendingContext: [] }),
      (err) => err.status === 400 && /available: greet, noargs/.test(err.message),
    )
    assert.equal(fake.state.commandInvocations.length, 0)
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('invokeCommand carries model overrides and pending shell context in arguments', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { driver, events } = await build(fake)
    driver.start()
    const queued = await driver.invokeCommand({
      command: 'noargs',
      arguments: 'focus',
      model: 'big-model',
      pendingContext: ['<zwrm-operator-shell-context>ls output</zwrm-operator-shell-context>'],
    })
    // The visible message shows the invocation, not the injected context.
    assert.deepEqual(queued, { command: 'noargs', visible: '/noargs focus' })
    await until(events, () => fake.state.commandInvocations.length === 1, 'the command to land')
    const body = fake.state.commandInvocations[0]
    assert.equal(body.model, 'zwrm/big-model')
    assert.equal(body.arguments, 'focus\n\n<zwrm-operator-shell-context>ls output</zwrm-operator-shell-context>')
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('Ask mode: the ask flows through the pending map; allow replies once', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake, newHarness({ spec: { permission_mode: 'default' } }))
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId

    fake.emit('permission.asked', {
      id: 'per_1', sessionID: sid, permission: 'bash',
      patterns: ['echo hi'], metadata: { command: 'echo hi' }, always: ['echo *'],
      tool: { messageID: 'm1', callID: 'c1' },
    })
    await until(events, (ev) => ofType(ev, 'permission.request').length === 1, 'the platform ask')
    const ask = ofType(events, 'permission.request')[0].payload
    assert.equal(ask.request_id, 'per_1')
    assert.equal(ask.tool_name, 'bash')
    assert.equal(ask.input.command, 'echo hi')
    assert.equal(ask.tool_use_id, 'c1')
    assert.equal(s.state, 'blocked')

    // The human approves through the shared pending map.
    s.pending.get('per_1').resolve({ behavior: 'allow', updatedInput: { command: 'echo hi' } })
    s.pending.delete('per_1')
    await until([], () => fake.state.replies.length === 1, 'the reply')
    assert.deepEqual(fake.state.replies[0], { permissionID: 'per_1', response: 'once' })
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('Ask mode: deny replies reject; bypass mode auto-approves with no platform ask', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake, newHarness({ spec: { permission_mode: 'default' } }))
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId

    fake.emit('permission.asked', { id: 'per_d', sessionID: sid, permission: 'edit', metadata: {}, tool: { callID: 'c9' } })
    await until(events, (ev) => ofType(ev, 'permission.request').length === 1, 'ask')
    s.pending.get('per_d').resolve({ behavior: 'deny', message: 'no' })
    s.pending.delete('per_d')
    await until([], () => fake.state.replies.length === 1, 'reject reply')
    assert.deepEqual(fake.state.replies[0], { permissionID: 'per_d', response: 'reject' })

    // Mode switch to bypass: the next ask is answered instantly, no event.
    await driver.setPermissionMode('bypassPermissions')
    fake.emit('permission.asked', { id: 'per_b', sessionID: sid, permission: 'bash', metadata: {}, tool: { callID: 'c10' } })
    await until([], () => fake.state.replies.length === 2, 'auto approval')
    assert.deepEqual(fake.state.replies[1], { permissionID: 'per_b', response: 'once' })
    assert.equal(ofType(events, 'permission.request').length, 1)
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('interrupt cancels the pending ask, rejects it upstream, aborts, and the retired turn emits no result', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake, newHarness({ spec: { permission_mode: 'default' } }))
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId
    fake.emit('permission.asked', { id: 'per_i', sessionID: sid, permission: 'bash', metadata: { command: 'sleep 999' }, tool: { callID: 'c1' } })
    await until(events, (ev) => ofType(ev, 'permission.request').length === 1, 'ask')

    await driver.interrupt()
    assert.equal(s.pending.size, 0)
    await until([], () => fake.state.aborts === 1, 'the abort call')
    await until([], () => fake.state.replies.length === 1, 'the upstream reject')
    assert.equal(fake.state.replies[0].response, 'reject')
    assert.equal(s.state, 'idle')

    // The aborted turn's late idle must not mint a result (claude parity).
    fake.emit('session.idle', { sessionID: sid })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(ofType(events, 'sdk.result').length, 0)
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('a run (auto_approve) approves native asks without a platform event', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake, newHarness({
      spec: { permission_mode: 'default', auto_approve: true, escalate_servers: ['github'], interactive: false },
    }))
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    fake.emit('permission.asked', { id: 'per_r', sessionID: s.sdkSessionId, permission: 'bash', metadata: {}, tool: { callID: 'c2' } })
    await until([], () => fake.state.replies.length === 1, 'auto approval')
    assert.equal(fake.state.replies[0].response, 'once')
    assert.equal(ofType(events, 'permission.request').length, 0)
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('a failed turn still emits exactly one result (the run-completion gate)', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake)
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId
    fake.emit('message.updated', { info: { sessionID: sid, role: 'assistant', error: { name: 'ProviderError', message: 'boom' } } })
    fake.emit('session.idle', { sessionID: sid })
    await until(events, (ev) => ofType(ev, 'sdk.result').length === 1, 'error result')
    const r = ofType(events, 'sdk.result')[0].payload
    assert.equal(r.subtype, 'error_during_execution')
    assert.equal(r.is_error, true)
    assert.match(r.result, /boom/)
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('resume: a live handle is reused and its cost becomes the baseline; a dead one self-heals', async () => {
  const fake = await startFakeOpenCode()
  try {
    fake.seedSession('ses_old', 0.5)
    const ctx = newHarness({ spec: { resume_sdk_session_id: 'ses_old' } })
    const { s, driver, events } = await build(fake, ctx)
    assert.equal(s.sdkSessionId, 'ses_old')
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    fake.setSessionCost('ses_old', 0.503)
    fake.emit('message.updated', { info: { sessionID: 'ses_old', role: 'assistant', cost: 0.503, tokens: { input: 10, output: 2, cache: {} } } })
    fake.emit('session.idle', { sessionID: 'ses_old' })
    await until(events, (ev) => ofType(ev, 'sdk.result').length === 1, 'result')
    // Cumulative for THIS platform session: 0.503 − the 0.5 baseline.
    assert.ok(Math.abs(ofType(events, 'sdk.result')[0].payload.total_cost_usd - 0.003) < 1e-9)

    // Dead handle: a fresh session is created and stamped.
    const fake2 = await startFakeOpenCode()
    try {
      const ctx2 = newHarness({ spec: { resume_sdk_session_id: 'ses_gone' } })
      const { s: s2 } = await build(fake2, ctx2)
      assert.match(s2.sdkSessionId, /^ses_fake/)
      fake2.assertNoViolations(assert)
    } finally {
      await fake2.close()
    }
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('connector asks surface under the canonical mcp__ name; escalated tools gate even on runs (#1392)', async () => {
  const fake = await startFakeOpenCode()
  try {
    const ctx = newHarness({
      spec: {
        permission_mode: 'default', auto_approve: true, escalate_servers: ['github'], interactive: false,
        mcp_servers: {
          github: { type: 'http', url: 'http://gw/mcp/github', headers: { Authorization: 'Bearer t' } },
          zwrm: { type: 'http', url: 'http://gw/mcp/zwrm', headers: { Authorization: 'Bearer t' } },
        },
      },
    })
    const { s, driver, events } = await build(fake, ctx)
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId

    // A non-escalated platform-server call auto-approves under the run policy.
    fake.emit('permission.asked', { id: 'per_z', sessionID: sid, permission: 'zwrm_save_memory', metadata: {}, tool: { callID: 'c1' } })
    await until([], () => fake.state.replies.length === 1, 'auto approval')
    assert.equal(fake.state.replies[0].response, 'once')
    assert.equal(ofType(events, 'permission.request').length, 0)

    // An escalated connector call PARKS for a human, under the canonical name.
    fake.emit('permission.asked', { id: 'per_g', sessionID: sid, permission: 'github_create_issue', metadata: { title: 'x' }, tool: { callID: 'c2' } })
    await until(events, (ev) => ofType(ev, 'permission.request').length === 1, 'escalated ask')
    const ask = ofType(events, 'permission.request')[0].payload
    assert.equal(ask.tool_name, 'mcp__github__create_issue')
    s.pending.get('per_g').resolve({ behavior: 'allow' })
    s.pending.delete('per_g')
    await until([], () => fake.state.replies.length === 2, 'escalated approval')

    // The transcript speaks the canonical name too.
    fake.emit('message.part.updated', { part: { id: 'p1', sessionID: sid, type: 'tool', tool: 'github_create_issue', callID: 'c2', state: { status: 'running', input: { title: 'x' } } } })
    await until(events, (ev) => ev.some((e) => e.type === 'sdk.assistant' && e.payload.message.content[0].type === 'tool_use'), 'tool_use')
    const use = ofType(events, 'sdk.assistant').find((e) => e.payload.message.content[0].type === 'tool_use')
    assert.equal(use.payload.message.content[0].name, 'mcp__github__create_issue')
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('unsupported permission modes are refused at construction with a 400', async () => {
  const fake = await startFakeOpenCode()
  try {
    const ctx = newHarness({ spec: { permission_mode: 'plan' } })
    await assert.rejects(() => build(fake, ctx), (err) => {
      assert.equal(err.status, 400)
      return true
    })
  } finally {
    await fake.close()
  }
})

test('end during an active turn finishes after the result; ending sessions auto-reject new asks', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake, newHarness({ spec: { permission_mode: 'default' } }))
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId

    s.ending = true
    driver.beginEnd()
    // A late ask on an ending session is rejected without a platform event.
    fake.emit('permission.asked', { id: 'per_late', sessionID: sid, permission: 'bash', metadata: {}, tool: { callID: 'c3' } })
    await until([], () => fake.state.replies.length === 1, 'late-ask rejection')
    assert.equal(fake.state.replies[0].response, 'reject')
    assert.equal(ofType(events, 'permission.request').length, 0)

    fake.emit('message.part.updated', { part: { id: 't1', sessionID: sid, type: 'text', text: 'wrapping up' } })
    fake.emit('session.idle', { sessionID: sid })
    await until(events, (ev) => ofType(ev, 'session.ended').length === 1, 'session end')
    assert.equal(ofType(events, 'sdk.result').length, 1)
    assert.equal(s.state, 'ended')
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

// ---- review-fix regressions -------------------------------------------------

test('a user message part never renders as assistant output or the summary', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake)
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId
    // The probed order: message.updated names the role, then parts stream.
    fake.emit('message.updated', { info: { sessionID: sid, id: 'mu', role: 'user' } })
    fake.emit('message.part.updated', { part: { id: 'pu', messageID: 'mu', sessionID: sid, type: 'text', text: 'go' } })
    fake.emit('message.updated', { info: { sessionID: sid, id: 'ma', role: 'assistant' } })
    fake.emit('message.part.updated', { part: { id: 'pa', messageID: 'ma', sessionID: sid, type: 'text', text: 'real answer' } })
    fake.emit('session.idle', { sessionID: sid })
    await until(events, (ev) => ofType(ev, 'sdk.result').length === 1, 'result')
    const texts = ofType(events, 'sdk.assistant').filter((e) => e.payload.message.content[0].type === 'text')
    assert.equal(texts.length, 1)
    assert.equal(texts[0].payload.message.content[0].text, 'real answer')
    assert.equal(ofType(events, 'sdk.result')[0].payload.result, 'real answer')
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('a follow-up the server ran as a NEW turn re-arms via busy and emits its own result', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake)
    driver.start()
    driver.queueMessage('first')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId
    fake.emit('message.part.updated', { part: { id: 't1', sessionID: sid, type: 'text', text: 'answer one' } })
    fake.emit('session.idle', { sessionID: sid })
    await until(events, (ev) => ofType(ev, 'sdk.result').length === 1, 'first result')

    // The server starts working again (the follow-up the driver believed
    // would fold, or any server-side continuation).
    fake.emit('session.status', { sessionID: sid, status: { type: 'busy' } })
    fake.emit('message.part.updated', { part: { id: 't2', sessionID: sid, type: 'text', text: 'answer two' } })
    fake.emit('session.idle', { sessionID: sid })
    await until(events, (ev) => ofType(ev, 'sdk.result').length === 2, 'second result')
    assert.equal(ofType(events, 'sdk.result')[1].payload.result, 'answer two')
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('busy after an interrupt does not resurrect the cancelled turn', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake)
    driver.start()
    driver.queueMessage('go')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId
    await driver.interrupt()
    // The aborted turn's tail: the server was still briefly busy.
    fake.emit('session.status', { sessionID: sid, status: { type: 'busy' } })
    fake.emit('session.idle', { sessionID: sid })
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(ofType(events, 'sdk.result').length, 0)
    assert.equal(s.state, 'idle')
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})

test('a prompt racing the chained result emit corrupts neither turn', async () => {
  const fake = await startFakeOpenCode()
  try {
    const { s, driver, events } = await build(fake)
    driver.start()
    driver.queueMessage('first')
    await until(events, () => fake.state.prompts.length === 1, 'prompt')
    const sid = s.sdkSessionId
    fake.emit('message.part.updated', { part: { id: 't1', sessionID: sid, type: 'text', text: 'first answer' } })
    fake.emit('message.updated', { info: { sessionID: sid, id: 'm1', role: 'assistant', cost: 0.001, tokens: { input: 10, output: 1, cache: {} } } })
    fake.emit('session.idle', { sessionID: sid })
    // Fire the next message IMMEDIATELY — likely before the idle has even
    // arrived over SSE, so the driver may take the follow-up branch while
    // the first turn's chained result emit is still pending (the
    // review-found window). The real server then reports `busy` for the new
    // work, which is what re-arms the platform turn.
    driver.queueMessage('second')
    await until(events, () => fake.state.prompts.length === 2, 'second prompt')
    await until(events, (ev) => ofType(ev, 'sdk.result').length === 1, 'first result')
    fake.emit('session.status', { sessionID: sid, status: { type: 'busy' } })
    fake.emit('message.part.updated', { part: { id: 't2', sessionID: sid, type: 'text', text: 'second answer' } })
    fake.emit('session.idle', { sessionID: sid })
    await until(events, (ev) => ofType(ev, 'sdk.result').length === 2, 'both results')
    const results = ofType(events, 'sdk.result').map((e) => e.payload.result)
    assert.deepEqual(results, ['first answer', 'second answer'])
    fake.assertNoViolations(assert)
  } finally {
    await fake.close()
  }
})
