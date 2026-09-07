// Driver-level tests for the codex harness (#1088), against a scripted fake
// `codex app-server` (test/fake-codex-app-server.mjs) that speaks the same
// newline-delimited JSON-RPC as the real binary. No API key, no network, no VM.
//
// These cover the parts the pure translators cannot: the turn state machine,
// the approval gate wired to the shared pending map, the exactly-one-result
// contract (sdk.result is the run-completion gate), and interrupt semantics.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexDriver, isStaleCodexTurnCompletion } from '../drivers/codex.mjs'

const FAKE = fileURLToPath(new URL('./fake-codex-app-server.mjs', import.meta.url))

test('an identified completion is stale while the next turn is still opening', () => {
  assert.equal(isStaleCodexTurnCompletion('retired', null, true), true)
  assert.equal(isStaleCodexTurnCompletion('live', 'live', true), false)
  assert.equal(isStaleCodexTurnCompletion('retired', 'live', true), true)
  assert.equal(isStaleCodexTurnCompletion(null, null, true), false)
})

// What the driver SENT to the app-server. Read from the fake's trace file
// rather than the event stream: the driver drops notification methods it does
// not know, which is deliberate, so a test-only notification never arrives.
function sentCalls(tracePath, method) {
  if (!existsSync(tracePath)) return []
  return readFileSync(tracePath, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((c) => !method || c.method === method)
    .map((c) => c.params)
}

// A stand-in for server.mjs's session record + helpers bag, capturing every
// emitted event so the contract can be asserted.
function newHarness({ scenario = 'simple', spec = {} } = {}) {
  const events = []
  const tracePath = join(mkdtempSync(join(tmpdir(), 'codexdrv-')), 'trace.jsonl')
  const s = {
    id: 'sess-1',
    state: 'starting',
    harness: 'codex',
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
    textResult: (t) => ({ content: [{ type: 'text', text: t }] }),
    parkTurn: async () => ({ content: [] }),
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
    VERSION: '0.8.0-test',
    MAX_SLEEP_SECONDS: 3600,
  }
  // Every harness gets its own CODEX_HOME. The driver writes auth.json and the
  // thread tool-set record there; without this the suite would read and write
  // the developer's real ~/.codex and leak state between tests.
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  const fullSpec = {
    session_id: 'sess-1',
    cwd: process.cwd(),
    permission_mode: 'bypassPermissions',
    ...spec,
    env: { FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_TRACE: tracePath, CODEX_HOME: codexHome, ...(spec.env || {}) },
  }
  return { s, h, spec: fullSpec, events, tracePath, codexHome }
}

async function build(opts) {
  const prev = process.env.ZWRM_CODEX_BIN
  process.env.ZWRM_CODEX_BIN = FAKE
  try {
    const ctx = opts ?? newHarness()
    const driver = await createCodexDriver(ctx.s, ctx.spec, ctx.h)
    return { ...ctx, driver }
  } finally {
    if (prev === undefined) delete process.env.ZWRM_CODEX_BIN
    else process.env.ZWRM_CODEX_BIN = prev
  }
}

// Wait until `pred(events)` holds, or fail with what actually arrived.
async function until(events, pred, what, timeoutMS = 5000) {
  const deadline = Date.now() + timeoutMS
  while (Date.now() < deadline) {
    if (pred(events)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail(`timed out waiting for ${what}; events: ${JSON.stringify(events.map((e) => e.type))}`)
}

const ofType = (events, type) => events.filter((e) => e.type === type)

// codex REQUIRES tokens.id_token and parses it as a JWT (measured with
// `codex login status`: "missing field `id_token`" / "invalid ID token
// format"), so a realistic subscription fixture must carry one.
const FAKE_ID_TOKEN = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ.sig'
const subscriptionRecord = (extra = {}) => ({
  auth_mode: 'chatgpt',
  tokens: { access_token: 'at-1', refresh_token: 'rt-1', account_id: 'acct-1', id_token: FAKE_ID_TOKEN },
  last_refresh: '2026-07-27T00:00:00Z',
  ...extra,
})

// The run tools every unattended session declares.
const RUN_TOOLS = ['zwrm__platform__sleep', 'zwrm__platform__sleep_until']

// Pre-record a thread's CONNECTOR set. An unknown thread resumes by design, so
// this is only needed to model a thread created with a DIFFERENT connector set.
function recordThreadConnectors(codexHome, records) {
  writeFileSync(join(codexHome, '.zwrm-thread-tools.json'), JSON.stringify(records))
}

test('a turn produces exactly one sdk.result, synced before it is observable', async () => {
  const ctx = await build(newHarness({ scenario: 'simple' }))
  ctx.driver.start()
  assert.equal(ctx.driver.queueMessage('hello'), true)
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')
  await new Promise((r) => setTimeout(r, 100)) // let any duplicate arrive

  const results = ofType(ctx.events, 'sdk.result')
  assert.equal(results.length, 1, 'exactly one result per turn (the run-completion gate)')
  assert.equal(results[0].payload.result, 'MARKER')
  assert.equal(results[0].payload.subtype, 'success')
  assert.equal(results[0].payload.total_cost_usd, 0, 'codex is unmetered (#1089)')
  assert.deepEqual(results[0].payload.usage, {
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 2, cache_creation_input_tokens: 0,
  })

  // #888: the transcript must be durable BEFORE the result is observable — the
  // CP tears the VM down on sdk.result for session-plane runs.
  const syncIdx = ctx.events.findIndex((e) => e.type === '__sync')
  const resIdx = ctx.events.findIndex((e) => e.type === 'sdk.result')
  assert.ok(syncIdx >= 0 && syncIdx < resIdx, 'syncToDisk must precede sdk.result')

  await ctx.driver.shutdownStop()
})

test('a todoList thread item becomes a todo.updated snapshot, not a transcript entry', async () => {
  const ctx = await build(newHarness({ scenario: 'todo' }))
  ctx.driver.start()
  assert.equal(ctx.driver.queueMessage('plan it'), true)
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')

  const updates = ofType(ctx.events, 'todo.updated')
  assert.equal(updates.length, 1, 'one snapshot per todoList item')
  assert.deepEqual(updates[0].payload, {
    todos: [
      { content: 'read the code', status: 'completed' },
      { content: 'write tests', status: 'pending' },
    ],
  })
  // The item must not leak into the transcript as a tool_use/tool_result.
  for (const e of [...ofType(ctx.events, 'sdk.assistant'), ...ofType(ctx.events, 'sdk.user')]) {
    const blocks = e.payload?.message?.content ?? []
    assert.ok(!blocks.some((b) => b?.type === 'tool_use' || b?.type === 'tool_result'),
      'todoList rendered as a transcript tool item')
  }

  await ctx.driver.shutdownStop()
})

test('a large prompt is delivered, not misread as a write failure', async () => {
  // stream.write() returns false once the queued bytes exceed the pipe's 64KB
  // high-water mark. That is BACKPRESSURE — the chunk is buffered and flushed
  // — but the driver used to report it as a failed write, failing the session
  // with "the codex app-server exited unexpectedly" while the app-server was
  // healthy and had already begun the turn. Agent instructions plus a memory
  // block, or any sizeable prompt, cross that mark routinely.
  const ctx = await build(newHarness({ scenario: 'simple' }))
  ctx.driver.start()
  const big = 'x'.repeat(300_000)
  assert.equal(ctx.driver.queueMessage(big), true)
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result', 10000)

  assert.equal(ofType(ctx.events, 'session.error').length, 0, 'a buffered write is not a session failure')
  const turns = sentCalls(ctx.tracePath, 'turn/start')
  assert.equal(turns.length, 1)
  assert.equal(turns[0].input[0].text.length, big.length, 'the whole prompt arrived intact')
  await ctx.driver.shutdownStop()
})

test('the OpenAI key is materialized as auth.json, not left in the environment', async () => {
  // Measured against the pinned binary: the app-server does NOT authenticate
  // from OPENAI_API_KEY in its environment. With the key in the child env and
  // no auth.json every turn fails `401 Unauthorized: Missing bearer` — it
  // never reaches the account. The same key in $CODEX_HOME/auth.json works.
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  const ctx = await build(newHarness({
    spec: { env: { FAKE_CODEX_SCENARIO: 'simple', CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-test-key' } },
  }))
  const authPath = join(codexHome, 'auth.json')
  assert.ok(existsSync(authPath), 'auth.json must be written before the app-server is spawned')
  assert.deepEqual(JSON.parse(readFileSync(authPath, 'utf8')),
    { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-key' })
  // A secret on the workspace volume: owner-only.
  assert.equal(statSync(authPath).mode & 0o777, 0o600)
  await ctx.driver.shutdownStop()
})

test('no OpenAI key leaves an existing login untouched', async () => {
  // An agent on a ChatGPT subscription logs in interactively; overwriting its
  // auth.json with an apikey record would sign it out.
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  writeFileSync(join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"id_token":"pre-existing"}}')
  const prev = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const ctx = await build(newHarness({
      spec: { env: { FAKE_CODEX_SCENARIO: 'simple', CODEX_HOME: codexHome } },
    }))
    const got = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8'))
    assert.equal(got.auth_mode, 'chatgpt', 'an interactive login must survive')
    await ctx.driver.shutdownStop()
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev
  }
})

test('a subscription secret is written verbatim as the codex login', async () => {
  // Codex's subscription credential is an OAuth record it renews IN PLACE, not
  // a single token — a bare access token would expire within hours. The secret
  // therefore carries the whole auth.json, and the driver passes it through
  // unparsed so a codex release can change the record's shape without breaking
  // us (#1144).
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  const record = subscriptionRecord()
  const ctx = await build(newHarness({
    spec: { env: { CODEX_HOME: codexHome, OPENAI_CODEX_AUTH: JSON.stringify(record) } },
  }))
  const authPath = join(codexHome, 'auth.json')
  assert.deepEqual(JSON.parse(readFileSync(authPath, 'utf8')), record)
  assert.equal(statSync(authPath).mode & 0o777, 0o600)
  await ctx.driver.shutdownStop()
})

test('the subscription wins when both credentials are set', async () => {
  // Already-paid capacity beats surprise API charges: a leftover API key must
  // not quietly start billing an org that has a ChatGPT plan.
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  const record = subscriptionRecord()
  const ctx = await build(newHarness({
    spec: {
      env: {
        CODEX_HOME: codexHome,
        OPENAI_CODEX_AUTH: JSON.stringify(record),
        OPENAI_API_KEY: 'sk-should-not-be-used',
      },
    },
  }))
  const got = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8'))
  assert.equal(got.auth_mode, 'chatgpt')
  assert.ok(!JSON.stringify(got).includes('sk-should-not-be-used'), 'the API key must not be written')
  await ctx.driver.shutdownStop()
})

test('a record missing id_token is refused, not written', async () => {
  // codex requires tokens.id_token and reads the account and plan from its
  // claims. Accepting a record without it would write a file codex then
  // refuses — surfacing as a parse error naming a FILE the operator never
  // wrote, rather than the secret they actually got wrong.
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  const partial = subscriptionRecord()
  delete partial.tokens.id_token
  await assert.rejects(
    () => build(newHarness({
      spec: { env: { CODEX_HOME: codexHome, OPENAI_CODEX_AUTH: JSON.stringify(partial) } },
    })),
    (err) => err.status === 400 && /id_token/.test(err.message),
  )
  assert.equal(existsSync(join(codexHome, 'auth.json')), false, 'nothing may be written')
})

test('a malformed subscription secret fails the session instead of writing garbage', async () => {
  // Writing an unreadable record would surface later as a bare 401, which
  // reads as "the harness is broken" and sends the operator hunting in
  // entirely the wrong place.
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  await assert.rejects(
    () => build(newHarness({
      spec: { env: { CODEX_HOME: codexHome, OPENAI_CODEX_AUTH: 'sk-just-a-bare-token' } },
    })),
    (err) => err.status === 400 && /auth_mode and tokens|not a codex auth record/i.test(err.message),
  )
  assert.equal(existsSync(join(codexHome, 'auth.json')), false, 'nothing may be written')
})

test('an interactive login that supersedes ours is never revoked', async () => {
  // The user may run `codex login` inside the workspace, and codex itself
  // rewrites auth.json whenever it refreshes tokens. Either makes the file
  // theirs, so a later revocation must leave it alone even though we wrote the
  // file that came before it.
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  const first = await build(newHarness({
    spec: { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-platform' } },
  }))
  await first.driver.shutdownStop()
  assert.ok(existsSync(join(codexHome, 'auth.json')))

  // The user logs in by hand, replacing what we wrote.
  writeFileSync(join(codexHome, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'theirs' } }))

  const prevKey = process.env.OPENAI_API_KEY
  const prevTok = process.env.OPENAI_CODEX_AUTH
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_CODEX_AUTH
  try {
    const ctx = await build(newHarness({ spec: { env: { CODEX_HOME: codexHome } } }))
    const got = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8'))
    assert.equal(got.tokens.access_token, 'theirs', "the user's own login must survive revocation")
    await ctx.driver.shutdownStop()
  } finally {
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey
    if (prevTok !== undefined) process.env.OPENAI_CODEX_AUTH = prevTok
  }
})

test('a revoked credential removes the login the platform wrote', async () => {
  // auth.json lives on the workspace VOLUME. Leaving it behind when the org
  // deletes the secret would keep the agent authenticating on a revoked
  // credential across reboots, for as long as the workspace exists.
  //
  // The file has to be one WE wrote, so the first session creates it: an
  // unmarked auth.json is the user's own (`codex login` by hand) and is
  // deliberately never touched.
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  const first = await build(newHarness({
    spec: { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-platform' } },
  }))
  await first.driver.shutdownStop()
  assert.ok(existsSync(join(codexHome, 'auth.json')), 'the first session writes the login')

  const prevKey = process.env.OPENAI_API_KEY
  const prevTok = process.env.OPENAI_CODEX_AUTH
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_CODEX_AUTH
  try {
    const ctx = await build(newHarness({ spec: { env: { CODEX_HOME: codexHome } } }))
    assert.equal(existsSync(join(codexHome, 'auth.json')), false,
      'a revoked credential must remove the login the platform wrote')
    await ctx.driver.shutdownStop()
  } finally {
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey
    if (prevTok !== undefined) process.env.OPENAI_CODEX_AUTH = prevTok
  }
})

test('a hand-made login the platform never wrote is left alone', async () => {
  // `codex login --with-api-key` inside the workspace produces an apikey
  // record indistinguishable by content from ours. Deleting it would sign the
  // user out of their own VM.
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  writeFileSync(join(codexHome, 'auth.json'),
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-theirs' }))
  const prevKey = process.env.OPENAI_API_KEY
  const prevTok = process.env.OPENAI_CODEX_AUTH
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_CODEX_AUTH
  try {
    const ctx = await build(newHarness({ spec: { env: { CODEX_HOME: codexHome } } }))
    assert.ok(existsSync(join(codexHome, 'auth.json')), "a login we did not write must survive")
    await ctx.driver.shutdownStop()
  } finally {
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey
    if (prevTok !== undefined) process.env.OPENAI_CODEX_AUTH = prevTok
  }
})

test('a dynamic tool call is executed by the daemon and answered', async () => {
  // The whole reason connectors are bridged rather than handed to codex's own
  // MCP client: the daemon executes the call, so it passes through the
  // platform gate. This exercises the real dispatch path end to end.
  const ctx = await build(newHarness({ scenario: 'dynamic-tool', spec: { interactive: false } }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')
  await until(ctx.events, () => sentCalls(ctx.tracePath, '__toolReply').length > 0, 'the tool reply')
  const reply = sentCalls(ctx.tracePath, '__toolReply')[0]
  assert.equal(reply.success, true, `the tool must run, got ${JSON.stringify(reply)}`)
  await ctx.driver.shutdownStop()
})

test('a call for a tool we can no longer serve fails instead of being ignored', async () => {
  // Reachable on a resumed thread: codex re-offers the set frozen at creation,
  // so a connector detached since leaves an offer with no handler. The model
  // must be told, never fed a fabricated result.
  const ctx = await build(newHarness({ scenario: 'unknown-tool', spec: { interactive: false } }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')
  await until(ctx.events, () => sentCalls(ctx.tracePath, '__toolReply').length > 0, 'the tool reply')
  const reply = sentCalls(ctx.tracePath, '__toolReply')[0]
  assert.equal(reply.success, false)
  assert.match(reply.contentItems[0].text, /no longer available/)
  await ctx.driver.shutdownStop()
})

test('the init event carries the thread id as the resume handle', async () => {
  const ctx = await build(newHarness())
  ctx.driver.start()
  const init = ofType(ctx.events, 'sdk.system')[0]
  assert.equal(init.payload.subtype, 'init')
  assert.equal(init.payload.session_id, 'thread-abc')
  assert.equal(ctx.s.sdkSessionId, 'thread-abc')
  await ctx.driver.shutdownStop()
})

test('append_system_prompt rides developerInstructions, never baseInstructions', async () => {
  // baseInstructions REPLACES codex's built-in prompt; the platform block must
  // ADD to it.
  const ctx = await build(newHarness({ spec: { append_system_prompt: 'PLATFORM BLOCK' } }))
  const p = sentCalls(ctx.tracePath, 'thread/start')[0]
  assert.equal(p.developerInstructions, 'PLATFORM BLOCK')
  assert.equal(p.baseInstructions, undefined)
  assert.equal(p.config.skip_git_repo_check, true, 'agent workspaces are not git repos')
  await ctx.driver.shutdownStop()
})

test('bypassPermissions and default map onto distinct codex approval/sandbox pairs', async () => {
  const bypass = await build(newHarness({ spec: { permission_mode: 'bypassPermissions' } }))
  const b = sentCalls(bypass.tracePath, 'thread/start')[0]
  assert.equal(b.approvalPolicy, 'never')
  assert.equal(b.sandbox, 'danger-full-access')
  await bypass.driver.shutdownStop()

  const ask = await build(newHarness({ spec: { permission_mode: 'default' } }))
  const a = sentCalls(ask.tracePath, 'thread/start')[0]
  assert.equal(a.approvalPolicy, 'on-request')
  assert.equal(a.sandbox, 'workspace-write')
  await ask.driver.shutdownStop()
})

test('an approval request blocks on the shared pending map and honours allow', async () => {
  const ctx = await build(newHarness({ scenario: 'approval', spec: { permission_mode: 'default' } }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')

  await until(ctx.events, (e) => ofType(e, 'permission.request').length > 0, 'permission.request')
  const req = ofType(ctx.events, 'permission.request')[0].payload
  assert.equal(req.tool_name, 'shell')
  assert.equal(req.input.command, 'rm -rf /')
  assert.equal(ctx.s.state, 'blocked', 'a session awaiting a human reads as blocked (#731)')

  // Answer the way server.mjs's POST /permissions/{id} does.
  const pending = ctx.s.pending.get(req.request_id)
  ctx.s.pending.delete(req.request_id)
  pending.resolve({ behavior: 'allow', updatedInput: pending.input })

  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')
  const toolResult = ofType(ctx.events, 'sdk.user')[0].payload.message.content[0]
  assert.equal(toolResult.is_error, undefined, 'an approved command is not an error')
  await ctx.driver.shutdownStop()
})

test('a denied approval declines the command and marks the result as an error', async () => {
  const ctx = await build(newHarness({ scenario: 'approval-denied', spec: { permission_mode: 'default' } }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')

  await until(ctx.events, (e) => ofType(e, 'permission.request').length > 0, 'permission.request')
  const req = ofType(ctx.events, 'permission.request')[0].payload
  const pending = ctx.s.pending.get(req.request_id)
  ctx.s.pending.delete(req.request_id)
  pending.resolve({ behavior: 'deny', message: 'nope' })

  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')
  const toolResult = ofType(ctx.events, 'sdk.user')[0].payload.message.content[0]
  assert.equal(toolResult.is_error, true, 'a declined command must not read as success')
  await ctx.driver.shutdownStop()
})

test('auto_approve runs codex-native tools without asking a human', async () => {
  // Only the auto-approve half is testable on this harness: gate() is reached
  // solely for codex-native requests (shell, apply_patch, permissions,
  // user input), and isEscalatedTool matches `mcp__<slug>__…` names that
  // arrive with #1090's dynamic-tool bridge. The escalation half gets its
  // test there.
  const ctx = await build(newHarness({
    scenario: 'approval',
    spec: { permission_mode: 'default', auto_approve: true },
  }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')
  assert.equal(ofType(ctx.events, 'permission.request').length, 0)
  await ctx.driver.shutdownStop()
})

test('an unattended run refuses the AskUserQuestion twin instead of fabricating answers', async () => {
  // Empty answers would let the model continue on fabricated certainty — the
  // claude-code #30983 failure mode the claude driver also refuses to repeat.
  // permission_mode 'default' matters: under bypassPermissions the gate
  // returns allow immediately, the handler throws for want of answers, and
  // the test would pass with the unattended guard deleted.
  const ctx = await build(newHarness({ scenario: 'user-input', spec: { interactive: false, permission_mode: 'default' } }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')
  const texts = ofType(ctx.events, 'sdk.assistant').flatMap((e) => e.payload.message.content).filter((c) => c.type === 'text')
  assert.ok(texts.some((t) => t.text === 'refused'), 'the question must be refused, not answered')
  assert.equal(ofType(ctx.events, 'permission.request').length, 0)
  await ctx.driver.shutdownStop()
})

test('an interactive Codex user-input request carries its question kind and ID-keyed answer', async () => {
  const ctx = await build(newHarness({
    scenario: 'user-input',
    spec: { interactive: true, permission_mode: 'default' },
  }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')

  await until(ctx.events, (events) => ofType(events, 'permission.request').length > 0, 'permission.request')
  const req = ofType(ctx.events, 'permission.request')[0].payload
  assert.equal(req.tool_name, 'request_user_input')
  assert.equal(req.kind, 'question')
  assert.equal(req.input.questions[0].id, 'q1')

  const pending = ctx.s.pending.get(req.request_id)
  ctx.s.pending.delete(req.request_id)
  pending.resolve({
    behavior: 'allow',
    updatedInput: { ...pending.input, answers: { q1: 'production' } },
  })

  await until(ctx.events, () => sentCalls(ctx.tracePath, '__userInputReply').length > 0, 'user-input reply')
  assert.deepEqual(sentCalls(ctx.tracePath, '__userInputReply')[0], { answers: { q1: 'production' } })
  await ctx.driver.shutdownStop()
})

test('a failed turn still emits a result — it is the run-completion gate', async () => {
  for (const scenario of ['turn-failed', 'error-notification']) {
    const ctx = await build(newHarness({ scenario }))
    ctx.driver.start()
    ctx.driver.queueMessage('go')
    await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, `sdk.result for ${scenario}`)
    const r = ofType(ctx.events, 'sdk.result')[0].payload
    assert.equal(r.subtype, 'error_during_execution', scenario)
    assert.equal(r.total_cost_usd, 0)
    await ctx.driver.shutdownStop()
  }
})

test('a turn that both errors and completes still emits exactly one result', async () => {
  // The both-carriers case emitResult's guard exists for. Without it the CP
  // banks two results for one turn and may complete the run twice.
  const ctx = await build(newHarness({ scenario: 'double-terminal' }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(ofType(ctx.events, 'sdk.result').length, 1)
  assert.equal(ofType(ctx.events, 'sdk.result')[0].payload.subtype, 'error_during_execution')
  await ctx.driver.shutdownStop()
})

test('willRetry means codex is retrying — not that the turn produced a result', async () => {
  // Emitting on a retry would complete an autonomous run mid-flight and tear
  // the VM down under a turn that is still going.
  const ctx = await build(newHarness({ scenario: 'will-retry' }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')
  await new Promise((r) => setTimeout(r, 100))
  const results = ofType(ctx.events, 'sdk.result')
  assert.equal(results.length, 1, 'the retry must not produce its own result')
  assert.equal(results[0].payload.subtype, 'success', 'the turn ultimately succeeded')
  await ctx.driver.shutdownStop()
})

test('a resumed thread reuses the handle and reports it back', async () => {
  const ctx = await build(newHarness({ spec: { resume_sdk_session_id: 'thread-abc' } }))
  const resumed = sentCalls(ctx.tracePath, 'thread/resume')
  assert.equal(resumed.length, 1, 'resume must not fall back to starting a fresh thread')
  assert.equal(resumed[0].threadId, 'thread-abc')
  assert.equal(sentCalls(ctx.tracePath, 'thread/start').length, 0)
  ctx.driver.start()
  assert.equal(ofType(ctx.events, 'sdk.system')[0].payload.session_id, 'thread-abc')
  await ctx.driver.shutdownStop()
})

test('a resume handle that no longer resolves starts a fresh thread', async () => {
  // The rollout lives on the workspace volume and can legitimately vanish (an
  // archive that fails to rehydrate, a restored snapshot) while the control
  // plane still holds the handle. Failing the session would wedge that
  // workspace key permanently — every session and run on it failing
  // identically, forever — because nothing clears the stored handle.
  const ctx = await build(newHarness({ scenario: 'resume-fails', spec: { resume_sdk_session_id: 'thread-gone' } }))
  assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 1, 'resume is attempted first')
  assert.equal(sentCalls(ctx.tracePath, 'thread/start').length, 1, 'then a fresh thread is started')

  // Self-healing: the init event carries the NEW thread id, which the control
  // plane stamps over the dead handle, so the next session resumes normally.
  ctx.driver.start()
  assert.equal(ofType(ctx.events, 'sdk.system')[0].payload.session_id, 'thread-abc')
  assert.equal(ctx.s.sdkSessionId, 'thread-abc')

  // And the session is fully usable, not merely constructed.
  ctx.driver.queueMessage('go')
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')
  assert.equal(ofType(ctx.events, 'sdk.result')[0].payload.result, 'MARKER')
  await ctx.driver.shutdownStop()
})

test('a thread that cannot be started at all is still a daemon fault', async () => {
  // The fallback above must not mask a genuinely broken app-server: when the
  // FRESH start fails too, that is auth/spawn/protocol and reads as 502.
  await assert.rejects(
    () => build(newHarness({ scenario: 'start-fails', spec: { resume_sdk_session_id: 'thread-gone' } })),
    (err) => err.status === 502 && /failed to start codex thread/.test(err.message),
  )
})

test('a turn interrupted while opening is cancelled even after a new turn starts', async () => {
  // The window: the interrupt lands before turn/started, so the turn has no id
  // to cancel and cancellation is deferred to the notification. If the driver
  // judges that late notification by a SHARED "generation of the last
  // request", the next message overwrites it, the retired turn is adopted as
  // live, and it keeps running its tool calls while the new message is steered
  // into the turn the user just cancelled.
  const ctx = await build(newHarness({ scenario: 'slow-open' }))
  ctx.driver.start()
  ctx.driver.queueMessage('one')
  await until(ctx.events, () => sentCalls(ctx.tracePath, 'turn/start').length > 0, 'the first turn/start')

  await ctx.driver.interrupt()
  ctx.driver.queueMessage('two')
  await until(ctx.events, () => sentCalls(ctx.tracePath, 'turn/start').length > 1, 'the second turn/start')

  // Turn 1's turn/started lands late (the fake holds it 150ms).
  await until(ctx.events, () => sentCalls(ctx.tracePath, 'turn/interrupt').length > 0,
    'the retired turn to be cancelled')
  const cancelled = sentCalls(ctx.tracePath, 'turn/interrupt').map((p) => p.turnId)
  assert.ok(cancelled.includes('turn-1-1'),
    `the interrupted turn must be cancelled, got interrupts for ${JSON.stringify(cancelled)}`)
  assert.ok(!cancelled.includes('turn-1-2'), 'the live turn must NOT be cancelled')

  // The second message opened its own turn rather than being steered into the
  // cancelled one.
  const turns = sentCalls(ctx.tracePath, 'turn/start')
  assert.equal(turns[1].input[0].text, 'two')
  assert.equal(sentCalls(ctx.tracePath, 'turn/steer').length, 0)
  await ctx.driver.shutdownStop()
})

test('messages queued during a cancelled turn are not replayed into the next one', async () => {
  // A message that arrives while a turn is still opening parks in pendingSteers.
  // If the interrupt leaves it queued, the next turn's flushSteers replays it —
  // after the prompt that actually opened that turn, so the model sees the
  // conversation out of order and acts on an instruction already withdrawn.
  const ctx = await build(newHarness({ scenario: 'slow-open' }))
  ctx.driver.start()
  ctx.driver.queueMessage('one')
  await until(ctx.events, () => sentCalls(ctx.tracePath, 'turn/start').length > 0, 'the first turn/start')
  // Parks: the turn is active but has no id yet.
  ctx.driver.queueMessage('parked-while-opening')

  await ctx.driver.interrupt()
  ctx.driver.queueMessage('after-interrupt')
  await until(ctx.events, () => ofType(ctx.events, 'sdk.result').length > 0, 'the new turn to complete')

  const steered = sentCalls(ctx.tracePath, 'turn/steer').map((p) => p.input?.[0]?.text)
  assert.ok(!steered.includes('parked-while-opening'),
    `the cancelled message must not be replayed, got steers ${JSON.stringify(steered)}`)
  const started = sentCalls(ctx.tracePath, 'turn/start').map((p) => p.input?.[0]?.text)
  assert.ok(!started.includes('parked-while-opening'),
    'nor delivered as a fresh turn')
  assert.ok(started.includes('after-interrupt'), 'the post-interrupt message is delivered')
  await ctx.driver.shutdownStop()
})

test('an interrupted turn emits no result and cancels pending approvals first', async () => {
  const ctx = await build(newHarness({ scenario: 'approval', spec: { permission_mode: 'default' } }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')
  await until(ctx.events, (e) => ofType(e, 'permission.request').length > 0, 'permission.request')

  // The approval is still outstanding, and the fake — like the real
  // app-server — will not answer turn/interrupt while a server->client
  // request is unanswered. Cancelling the gate FIRST is what keeps this
  // prompt; doing it after would stall until the teardown timeout fires.
  // Asserting the duration is what makes the ordering testable at all: the
  // timeout means a deadlock degrades to a long pause rather than a hang.
  const startedAt = Date.now()
  await ctx.driver.interrupt()
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 2000, `interrupt took ${elapsed}ms; pending approvals must be cancelled before turn/interrupt`)
  assert.equal(ctx.s.pending.size, 0, 'interrupt must drain the pending gate')
  assert.ok(
    ofType(ctx.events, 'permission.decision').some((e) => e.payload.behavior === 'cancel'),
    'the cancelled approval must be reported',
  )

  await new Promise((r) => setTimeout(r, 150))
  assert.equal(ofType(ctx.events, 'sdk.result').length, 0, 'an interrupted turn produces no result (claude parity)')
  await ctx.driver.shutdownStop()
})

test('a message during a live turn steers it instead of opening a second turn', async () => {
  const ctx = await build(newHarness({ scenario: 'interrupt' })) // a turn that never ends
  ctx.driver.start()
  ctx.driver.queueMessage('first')
  await until(ctx.events, () => sentCalls(ctx.tracePath, 'turn/start').length > 0, 'turn/start')
  ctx.driver.queueMessage('second')
  await until(ctx.events, () => sentCalls(ctx.tracePath, 'turn/steer').length > 0, 'turn/steer')

  assert.equal(sentCalls(ctx.tracePath, 'turn/start').length, 1, 'only one turn opened')
  const steer = sentCalls(ctx.tracePath, 'turn/steer')[0]
  assert.equal(steer.input[0].text, 'second')
  assert.ok(steer.expectedTurnId, 'steering is guarded by the active-turn precondition')
  await ctx.driver.shutdownStop()
})

test('a steer that loses the turn race is retried as a new turn, not dropped', async () => {
  // The scenario keeps the first turn LIVE and rejects turn/steer, so the
  // second message genuinely takes the steer path and genuinely fails there —
  // otherwise the retry is never executed and the test proves nothing.
  const ctx = await build(newHarness({ scenario: 'steer-precondition' }))
  ctx.driver.start()
  ctx.driver.queueMessage('first')
  await until(ctx.events, () => sentCalls(ctx.tracePath, 'turn/start').length > 0, 'turn/start')
  ctx.driver.queueMessage('second')
  await until(ctx.events, () => sentCalls(ctx.tracePath, 'turn/steer').length > 0, 'turn/steer attempted')
  await until(ctx.events, () => sentCalls(ctx.tracePath, 'turn/start').length >= 2, 'a second turn/start')

  const steers = sentCalls(ctx.tracePath, 'turn/steer')
  assert.equal(steers.length, 1, 'the steer is attempted once, then retried as a turn')
  const turns = sentCalls(ctx.tracePath, 'turn/start')
  assert.equal(turns[1].input[0].text, 'second', 'the message must still be delivered')
  // A steer failure must never kill the session.
  assert.equal(ofType(ctx.events, 'session.error').length, 0)
  await ctx.driver.shutdownStop()
})

test('the model and effort the CP resolved reach codex verbatim', async () => {
  // The control plane resolves the model against its catalog and clamps the
  // effort to what THAT model supports (state.ClampCodexEffort, #1089). The
  // driver must forward both untouched: a second clamp here would be
  // model-blind and could only disagree with the value already persisted on
  // the run — and 'max' is a real level on Astra.
  const ctx = await build(newHarness({ spec: { effort: 'max', model: 'gpt-6-astra' } }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')
  await until(ctx.events, () => sentCalls(ctx.tracePath, 'turn/start').length > 0, 'turn/start')
  const p = sentCalls(ctx.tracePath, 'turn/start')[0]
  assert.equal(p.effort, 'max')
  assert.equal(p.model, 'gpt-6-astra')
  await ctx.driver.shutdownStop()
})

test('an unsupported permission mode is rejected as a client error', async () => {
  await assert.rejects(
    () => build(newHarness({ spec: { permission_mode: 'plan' } })),
    (err) => err.status === 400 && /permission modes/.test(err.message),
  )
})

test('a thread created with different connectors is not resumed', async () => {
  // Codex freezes a thread's dynamic tools at creation and re-offers them on
  // resume, so resuming after a connector changed would run the wrong toolset
  // for the rest of that conversation, with no way to correct it.
  const h0 = newHarness({ spec: { resume_sdk_session_id: 'thread-abc' } })
  recordThreadConnectors(h0.codexHome, { 'thread-abc': 'github' })
  const ctx = await build(h0)

  assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 0, 'a stale connector set must not be resumed')
  assert.equal(sentCalls(ctx.tracePath, 'thread/start').length, 1, 'a fresh thread is started instead')
  await ctx.driver.shutdownStop()
})

test('the record is judged per THREAD, not by whichever is newest', async () => {
  // An explicit resume_session_id may name an older thread. Judging it against
  // some other thread's record would silently discard the very conversation
  // the caller asked to continue, and blame a connector change that never
  // happened. Two records, and the one we are NOT resuming differs.
  const h0 = newHarness({ spec: { resume_sdk_session_id: 'thread-abc' } })
  recordThreadConnectors(h0.codexHome, { 'thread-other': 'github', 'thread-abc': '' })
  const ctx = await build(h0)
  assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 1,
    'the requested thread matches its OWN record and must be resumed')
  await ctx.driver.shutdownStop()
})

test('chat and runs on one workspace resume the same thread', async () => {
  // The regression this guards: fingerprinting DISCOVERED tools put the
  // run-only sleep tools in the record, so a run and a chat could never agree
  // and every alternation between them silently discarded the conversation —
  // on the normal usage pattern, not an edge case.
  const run = newHarness({ spec: { resume_sdk_session_id: 'thread-abc', interactive: false } })
  const runCtx = await build(run)
  await runCtx.driver.shutdownStop()

  const chat = newHarness({ spec: { resume_sdk_session_id: 'thread-abc', interactive: true } })
  chat.spec.env.CODEX_HOME = run.codexHome
  const chatCtx = await build(chat)
  assert.equal(sentCalls(chatCtx.tracePath, 'thread/resume').length, 1,
    'a chat must resume the thread a run created on the same workspace')
  await chatCtx.driver.shutdownStop()
})

test('an unknown thread is resumed rather than discarded', async () => {
  // A record we do not have is not evidence of a change. Resuming risks a
  // stale toolset, which is visible and recoverable; discarding destroys
  // conversation context silently and permanently.
  const ctx = await build(newHarness({ spec: { resume_sdk_session_id: 'thread-abc' } }))
  assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 1)
  await ctx.driver.shutdownStop()
})

test('an unattended session declares the platform run tools', async () => {
  const ctx = await build(newHarness({ spec: { interactive: false } }))
  const declared = (sentCalls(ctx.tracePath, 'thread/start')[0].dynamicTools || []).map((t) => t.name)
  assert.deepEqual(declared.sort(), RUN_TOOLS)
  // Codex RESERVES the mcp__ prefix — declaring one is rejected outright —
  // which is why the platform's canonical names never go on this wire.
  for (const name of declared) assert.ok(!name.startsWith('mcp__'), name)
  await ctx.driver.shutdownStop()
})

test('the platform skills directory is registered with codex own loader', async () => {
  // Codex HAS a SKILL.md loader (the issue's premise that it does not is
  // wrong), so this is wiring rather than substitution: point it at the
  // directory SeedSkills already writes. Verified against the pinned binary —
  // a skill placed there lists as scope=user, enabled.
  const ctx = await build(newHarness())
  const calls = sentCalls(ctx.tracePath, 'skills/extraRoots/set')
  assert.equal(calls.length, 1, 'registered once, before any thread')
  assert.ok(calls[0].extraRoots.some((r) => r.endsWith('/.claude/skills')),
    `expected the platform skills dir, got ${JSON.stringify(calls[0].extraRoots)}`)
  await ctx.driver.shutdownStop()
})

test('an interactive session declares no run tools', async () => {
  // A human is on the stream; sleeping is a run-only affordance.
  const ctx = await build(newHarness({ spec: { interactive: true } }))
  assert.equal(sentCalls(ctx.tracePath, 'thread/start')[0].dynamicTools, undefined)
  await ctx.driver.shutdownStop()
})

test('a thread that fails to start surfaces as a bad gateway, not a silent session', async () => {
  await assert.rejects(
    () => build(newHarness({ scenario: 'start-fails' })),
    (err) => err.status === 502 && /Unauthorized/.test(err.message),
  )
})

test('shutdown ends the session and reports the last result', async () => {
  const ctx = await build(newHarness())
  ctx.driver.start()
  ctx.driver.queueMessage('go')
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')
  await ctx.driver.shutdownStop()
  assert.equal(ctx.s.state, 'ended')
  const ended = ofType(ctx.events, 'session.ended')
  assert.equal(ended.length, 1)
  assert.equal(ended[0].payload.sdk_session_id, 'thread-abc')
})
