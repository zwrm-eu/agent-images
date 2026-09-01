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

test('connector servers are refused until #1392; the reserved zwrm server is skipped', async () => {
  const fake = await startFakeOpenCode()
  try {
    const ctx = newHarness({ spec: { mcp_servers: { github: { url: 'http://x' } } } })
    await assert.rejects(() => build(fake, ctx), (err) => {
      assert.equal(err.status, 400)
      assert.match(err.message, /connector tools are not yet supported/)
      return true
    })
    const ctx2 = newHarness({ spec: { mcp_servers: { zwrm: { url: 'http://x' } } } })
    const { driver } = await build(fake, ctx2)
    await driver.shutdownStop()
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
