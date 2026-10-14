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
import { cpSync, mkdtempSync, readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexRolloutHistory,
  createCodexDriver,
  isCodexContextualUserText,
  isStaleCodexTurnCompletion,
  readCodexRolloutLineage,
} from '../drivers/codex.mjs'

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
    pusher: { emit: (type, payload, opts) => events.push({ type, payload, ephemeral: !!opts?.ephemeral, ...(opts && 'turnId' in opts ? { turnId: opts.turnId } : {}) }) },
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
    // A credential by default: without one the driver refuses to start
    // (#1703). Tests about credentials set or clear it themselves.
    env: { FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_TRACE: tracePath, CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-test-default', ...(spec.env || {}) },
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

test('setModel re-points the NEXT turn/start and leaves the thread alone (#1552)', async () => {
  const ctx = await build(newHarness({ scenario: 'simple', spec: { model: 'gpt-5.5', effort: 'medium' } }))
  ctx.driver.start()
  assert.equal(ctx.driver.queueMessage('first'), true)
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length === 1, 'first result')

  await ctx.driver.setModel({ model: 'gpt-5.6', effort: 'xhigh' })
  assert.equal(ctx.spec.model, 'gpt-5.6', 'the driver owns the spec mutation')
  assert.equal(ctx.spec.effort, 'xhigh')
  assert.equal(ctx.driver.queueMessage('second'), true)
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length === 2, 'second result')

  const turns = sentCalls(ctx.tracePath, 'turn/start')
  assert.equal(turns.length, 2)
  assert.equal(turns[0].model, 'gpt-5.5')
  assert.equal(turns[0].effort, 'medium')
  assert.equal(turns[1].model, 'gpt-5.6', 'the switch rides the next turn/start')
  assert.equal(turns[1].effort, 'xhigh')
  assert.equal(sentCalls(ctx.tracePath, 'thread/start').length, 1, 'the thread is not restarted')
  // Assistant text after the switch is attributed to the new model.
  const texts = ofType(ctx.events, 'sdk.assistant')
  assert.equal(texts[texts.length - 1].payload.message.model, 'gpt-5.6')
  await ctx.driver.shutdownStop()
})

test('compact asks the app-server between turns and resolves on its signal; auto-compactions are recorded once (#1553)', async () => {
  const ctx = await build(newHarness({ scenario: 'simple' }))
  ctx.driver.start()
  assert.equal(ctx.driver.queueMessage('first'), true)
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length === 1, 'first result')
  // Context usage rides every result (#1553): this turn's request against
  // the window the app-server reports.
  const usage = ofType(ctx.events, 'context.usage')
  assert.equal(usage.length, 1)
  assert.deepEqual(usage[0].payload, { tokens: 30, window: 400000 })
  assert.equal(usage[0].turnId, null, 'session-level accounting, outside any turn')

  const outcome = await ctx.driver.compact({ instructions: 'recorded, not sent' })
  assert.deepEqual(outcome, { trigger: 'manual', instructions: 'recorded, not sent' }, 'codex 0.160.0 reports no counts')
  assert.equal(sentCalls(ctx.tracePath, 'thread/compact/start').length, 1)
  // The driver records the manual compaction once, outside any turn; the
  // second signal for the same compaction must not become an 'auto' one.
  await new Promise((r) => setTimeout(r, 50))
  const recorded = ofType(ctx.events, 'context.compacted')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].turnId, null, 'recorded outside any turn')
  assert.deepEqual(recorded[0].payload, outcome)
  assert.equal(ctx.s.state, 'idle', 'a compaction is not a turn')

  assert.equal(ctx.driver.queueMessage('second'), true)
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length === 2, 'second result')
  assert.equal(sentCalls(ctx.tracePath, 'thread/start').length, 1, 'the thread is not restarted')
  await ctx.driver.shutdownStop()
})

test('an automatic codex compaction lands on the timeline as one context.compacted (#1553)', async () => {
  const ctx = await build(newHarness({ scenario: 'auto-compaction' }))
  ctx.driver.start()
  assert.equal(ctx.driver.queueMessage('go'), true)
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length === 1, 'result')
  const compacted = ofType(ctx.events, 'context.compacted')
  assert.equal(compacted.length, 1, 'both signals describe one compaction')
  assert.deepEqual(compacted[0].payload, { trigger: 'auto' })
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
      spec: { env: { FAKE_CODEX_SCENARIO: 'simple', CODEX_HOME: codexHome, OPENAI_API_KEY: '' } },
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
    const ctx = await build(newHarness({ spec: { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: '' } } }))
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
    // Revoked and nothing else to log in with: the login we wrote is
    // removed, and the session is refused with the fix rather than started
    // into a 401 (#1703).
    await assert.rejects(build(newHarness({ spec: { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: '' } } })),
      (err) => err.status === 400 && /No OpenAI credential/.test(err.message))
    assert.equal(existsSync(join(codexHome, 'auth.json')), false,
      'a revoked credential must remove the login the platform wrote')
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
    const ctx = await build(newHarness({ spec: { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: '' } } }))
    assert.ok(existsSync(join(codexHome, 'auth.json')), "a login we did not write must survive")
    await ctx.driver.shutdownStop()
  } finally {
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey
    if (prevTok !== undefined) process.env.OPENAI_CODEX_AUTH = prevTok
  }
})

test('no credential and no login refuses the session with the fix (#1703)', async () => {
  // Without any login every turn is a 401 that codex reports only as an
  // opaque systemError; the driver must say what is missing instead.
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  const prevKey = process.env.OPENAI_API_KEY
  const prevTok = process.env.OPENAI_CODEX_AUTH
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_CODEX_AUTH
  try {
    await assert.rejects(build(newHarness({ spec: { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: '' } } })),
      (err) => err.status === 400 && /OPENAI_API_KEY/.test(err.message) && /OPENAI_CODEX_AUTH/.test(err.message))
  } finally {
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey
    if (prevTok !== undefined) process.env.OPENAI_CODEX_AUTH = prevTok
  }
})

test('a set credential whose login cannot be written is reported as such, not as missing', async () => {
  // CODEX_HOME is a FILE, so mkdir/write fail while the key is configured.
  const dir = mkdtempSync(join(tmpdir(), 'codexhome-'))
  const codexHome = join(dir, 'not-a-dir')
  writeFileSync(codexHome, 'x')
  await assert.rejects(build(newHarness({ spec: { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-set' } } })),
    (err) => err.status === 500 && /could not write the codex login/.test(err.message) && !/No OpenAI credential/.test(err.message))
})

test('a keyring-stored login (no auth.json) is not refused', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
  writeFileSync(join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n')
  const prevKey = process.env.OPENAI_API_KEY
  const prevTok = process.env.OPENAI_CODEX_AUTH
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_CODEX_AUTH
  try {
    const ctx = await build(newHarness({ spec: { env: { FAKE_CODEX_SCENARIO: 'simple', CODEX_HOME: codexHome, OPENAI_API_KEY: '' } } }))
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
  await questionRoundTrip('default')
})

test('bypassPermissions does not auto-answer a Codex question: it still parks on the platform (#1555)', async () => {
  // Before #1555 the gate short-circuited on bypass and the handler then
  // threw for want of answers — every question failed in the dashboard's
  // Bypass mode.
  await questionRoundTrip('bypassPermissions')
})

async function questionRoundTrip(permissionMode) {
  const ctx = await build(newHarness({
    scenario: 'user-input',
    spec: { interactive: true, permission_mode: permissionMode },
  }))
  ctx.driver.start()
  ctx.driver.queueMessage('go')

  await until(ctx.events, (events) => ofType(events, 'permission.request').length > 0, 'permission.request')
  const req = ofType(ctx.events, 'permission.request')[0].payload
  assert.equal(req.tool_name, 'request_user_input')
  assert.equal(req.kind, 'question')
  // The platform shape (#1559): codex's id, no isOther/isSecret leakage.
  assert.deepEqual(req.input.questions[0], {
    id: 'q1', question: 'which?', header: 'Env', multiSelect: false,
    options: [{ label: 'staging', description: 's' }, { label: 'production', description: 'p' }],
  })

  const pending = ctx.s.pending.get(req.request_id)
  ctx.s.pending.delete(req.request_id)
  pending.resolve({
    behavior: 'allow',
    updatedInput: { ...pending.input, answers: { q1: 'production' } },
  })

  // Codex's RequestUserInputResponse, not the platform's flat map.
  await until(ctx.events, () => sentCalls(ctx.tracePath, '__userInputReply').length > 0, 'user-input reply')
  assert.deepEqual(sentCalls(ctx.tracePath, '__userInputReply')[0], { answers: { q1: { answers: ['production'] } } })
  await ctx.driver.shutdownStop()
}

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

// ---- instructions scope (#1832) ---------------------------------------------
//
// A thread created for one member's private chat carries that member's
// instructions in its developer message, and codex replays it on resume. A
// session with another instructions scope must REBUILD the thread instead:
// a new thread on its own instructions, with the old conversation injected.
//
// The rollouts under fixtures/codex-rollouts were recorded against the pinned
// codex 0.160.0 with a fake model (then trimmed, paths and ids replaced):
// Alice's private chat, developerInstructions ALICE-PRIVATE-MEMORY-7731 and a
// private skill alice-private-notes, one turn with an exec_command call and a
// reasoning item, then a second turn. `compact` adds a manual compaction and
// a third turn; `revert` reverts the second turn, which leaves the thread on
// a second rollout that continues the first (session_meta.history_base).
// `remote` ran on codex's built-in OpenAI provider (a fake key against a
// loopback server), whose compaction is remote: the older turns become one
// encrypted compaction item, plus the plain messages it retained.

const ROLLOUTS = fileURLToPath(new URL('./fixtures/codex-rollouts/', import.meta.url))
const FIXTURE = {
  basic: '019a1832-0000-7000-8000-0000000000b1',
  compact: '019a1832-0000-7000-8000-0000000000c1',
  revert: '019a1832-0000-7000-8000-0000000000d1',
  remote: '019a1832-0000-7000-8000-0000000000e1',
}
const ALICE_TEXT = ['ALICE-PRIVATE-MEMORY-7731', 'alice-private-notes', 'ALICE-SKILL-DESC-9191']
// Codex's own compaction summary prefix (prompts/templates/compact/summary_prefix.md).
const SUMMARY_PREFIX = 'Another language model started to solve this problem and produced a summary of its ' +
  'thinking process. You also have access to the state of the tools that were used by that language model. ' +
  'Use this to build on the work that has already been done and avoid duplicating work. Here is the summary ' +
  'produced by the other language model, use the information in this summary to assist with your own analysis:'

// One line per item, enough to read a history at a glance in an assertion.
const describe = (it) => `${it.type}:${it.role ?? ''}:${it.content?.[0]?.text ?? it.call_id ?? it.encrypted_content ?? ''}`

// What a rebuild carries of the basic fixture: the plain conversation. The
// reasoning item (encrypted, and bound to the account that made it) stays
// behind.
const BASIC_CONVERSATION = [
  'message:user:RUN-TOOL: draft the offer for ACME',
  'function_call::call_probe_1',
  'function_call_output::call_probe_1',
  'message:assistant:after-tool-2: the command printed its marker',
  'message:user:SECOND-TURN: make it more formal',
  'message:assistant:ack-3',
]

// Copy a fixture into the harness's CODEX_HOME; returns the thread's current
// rollout (a reverted thread's newer one).
function seedRollout(codexHome, name) {
  cpSync(join(ROLLOUTS, name), codexHome, { recursive: true })
  const dir = join(codexHome, 'sessions', '2026', '10', '14')
  const files = readdirSync(dir)
  return join(dir, files.find((f) => f.includes('_')) ?? files[0])
}

// A session resuming a fixture thread under an instructions scope. The fake's
// thread/read answers with the seeded rollout unless pointRead is false.
function scopedHarness({ scenario = 'simple', scope, resume = FIXTURE.basic, record, rollout = 'basic', pointRead = true } = {}) {
  const ctx = newHarness({
    scenario,
    spec: {
      resume_sdk_session_id: resume,
      append_system_prompt: 'SHARED PROMPT',
      ...(scope !== undefined ? { instructions_scope: scope } : {}),
    },
  })
  if (rollout) {
    const path = seedRollout(ctx.codexHome, rollout)
    if (pointRead) ctx.spec.env.FAKE_CODEX_ROLLOUT = path
  }
  if (record !== undefined) recordThreadConnectors(ctx.codexHome, record)
  return ctx
}

const threadRecords = (codexHome) => JSON.parse(readFileSync(join(codexHome, '.zwrm-thread-tools.json'), 'utf8'))

// The session is on a usable thread: the init event names it and a turn runs.
async function assertUsable(ctx, threadId = 'thread-abc') {
  ctx.driver.start()
  assert.equal(ofType(ctx.events, 'sdk.system')[0].payload.session_id, threadId)
  ctx.driver.queueMessage('go')
  await until(ctx.events, (e) => ofType(e, 'sdk.result').length > 0, 'sdk.result')
  assert.equal(ofType(ctx.events, 'sdk.result')[0].payload.result, 'MARKER')
}

test('a thread resumes when the session has the scope it was created for (#1832)', async () => {
  const ctx = await build(scopedHarness({
    scope: 'member:alice',
    record: { [FIXTURE.basic]: { tools: '', scope: 'member:alice' } },
  }))
  assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 1)
  assert.equal(sentCalls(ctx.tracePath, 'thread/resume')[0].threadId, FIXTURE.basic)
  assert.equal(sentCalls(ctx.tracePath, 'thread/start').length, 0)
  assert.equal(sentCalls(ctx.tracePath, 'thread/read').length, 0, 'nothing to rebuild')
  assert.equal(sentCalls(ctx.tracePath, 'thread/inject_items').length, 0)
  assert.deepEqual(threadRecords(ctx.codexHome)['thread-abc'], { tools: '', scope: 'member:alice' })
  await ctx.driver.shutdownStop()
})

test("a member's thread continued in a shared chat is rebuilt without its instructions (#1832)", async () => {
  const ctx = await build(scopedHarness({
    scope: 'shared',
    record: { [FIXTURE.basic]: { tools: '', scope: 'member:alice' } },
  }))
  // Resuming would replay the developer message the thread began with.
  assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 0, 'the old thread must never be resumed')
  assert.deepEqual(sentCalls(ctx.tracePath, 'thread/read').map((p) => p.threadId), [FIXTURE.basic])
  const starts = sentCalls(ctx.tracePath, 'thread/start')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].developerInstructions, 'SHARED PROMPT', "the new thread runs on this session's instructions")

  const injects = sentCalls(ctx.tracePath, 'thread/inject_items')
  assert.equal(injects.length, 1)
  assert.equal(injects[0].threadId, 'thread-abc', 'into the NEW thread')
  assert.deepEqual(injects[0].items.map(describe), BASIC_CONVERSATION)
  const carried = JSON.stringify(injects[0].items)
  for (const text of ALICE_TEXT) assert.ok(!carried.includes(text), `${text} must stay behind`)
  assert.ok(!carried.includes('<environment_context>'), 'codex writes the new thread its own context')
  // Nothing encrypted, and no ids naming the old account's items; the call
  // still comes before its output.
  assert.ok(!carried.includes('ENC-REASONING-6060-1'), 'the encrypted reasoning stays behind')
  assert.ok(injects[0].items.every((i) => i.id === undefined), 'no item ids')
  const call = injects[0].items.find((i) => i.type === 'function_call')
  const output = injects[0].items.find((i) => i.type === 'function_call_output')
  assert.equal(call.call_id, output.call_id)
  assert.match(JSON.stringify(output.output), /TOOL-OUTPUT-5150/)

  // The control plane stamps the new thread from the init event, and the
  // record holds the scope it was rebuilt for.
  assert.deepEqual(threadRecords(ctx.codexHome)['thread-abc'], { tools: '', scope: 'shared' })
  assert.deepEqual(threadRecords(ctx.codexHome)[FIXTURE.basic], { tools: '', scope: 'member:alice' })
  await assertUsable(ctx)
  await ctx.driver.shutdownStop()
})

test('a thread from before the scope record is rebuilt for a shared chat (#1832)', async () => {
  // A private chat's thread from an older daemon may be continued in a
  // shared chat now; nothing says whose instructions it carries.
  for (const record of [{ [FIXTURE.basic]: '' }, undefined]) {
    const ctx = await build(scopedHarness({ scope: 'shared', record }))
    assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 0, JSON.stringify(record))
    assert.equal(sentCalls(ctx.tracePath, 'thread/inject_items').length, 1, JSON.stringify(record))
    assert.deepEqual(sentCalls(ctx.tracePath, 'thread/inject_items')[0].items.map(describe), BASIC_CONVERSATION)
    assert.deepEqual(threadRecords(ctx.codexHome)['thread-abc'], { tools: '', scope: 'shared' })
    await ctx.driver.shutdownStop()
  }
})

test('a thread from before the scope record still resumes in a private chat (#1832)', async () => {
  const ctx = await build(scopedHarness({ scope: 'member:alice', record: { [FIXTURE.basic]: '' } }))
  assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 1)
  assert.equal(sentCalls(ctx.tracePath, 'thread/inject_items').length, 0)
  // Resuming says nothing about the instructions the thread carries: its
  // scope stays unknown, and a shared chat would still rebuild it.
  assert.deepEqual(threadRecords(ctx.codexHome)['thread-abc'], { tools: '' })
  await ctx.driver.shutdownStop()
})

test('a control plane that sends no scope resumes as before, unless the thread has a known one (#1832)', async () => {
  const unknown = await build(scopedHarness({ record: { [FIXTURE.basic]: '' } }))
  assert.equal(sentCalls(unknown.tracePath, 'thread/resume').length, 1)
  await unknown.driver.shutdownStop()

  const known = await build(scopedHarness({ record: { [FIXTURE.basic]: { tools: '', scope: 'member:alice' } } }))
  assert.equal(sentCalls(known.tracePath, 'thread/resume').length, 0, 'a known scope that differs is rebuilt')
  assert.equal(sentCalls(known.tracePath, 'thread/inject_items').length, 1)
  assert.deepEqual(threadRecords(known.codexHome)['thread-abc'], { tools: '' })
  await known.driver.shutdownStop()
})

test('a connector change still forfeits the thread before any rebuild (#1832)', async () => {
  const ctx = await build(scopedHarness({
    scope: 'shared',
    record: { [FIXTURE.basic]: { tools: 'github', scope: 'member:alice' } },
  }))
  assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 0)
  assert.equal(sentCalls(ctx.tracePath, 'thread/read').length, 0)
  assert.equal(sentCalls(ctx.tracePath, 'thread/inject_items').length, 0)
  assert.equal(sentCalls(ctx.tracePath, 'thread/start').length, 1)
  await ctx.driver.shutdownStop()
})

test('a thread that cannot be rebuilt starts fresh and is never resumed (#1832)', async () => {
  const record = { [FIXTURE.basic]: { tools: '', scope: 'member:alice' } }
  const cases = {
    // thread/read names no rollout and the sessions directory has none.
    'no rollout': scopedHarness({ scope: 'shared', record, rollout: null }),
    // The file the app-server names is not a codex rollout.
    'not a rollout': (() => {
      const ctx = scopedHarness({ scope: 'shared', record, rollout: null })
      const bogus = join(ctx.codexHome, 'bogus.jsonl')
      writeFileSync(bogus, '{"type":"event_msg","payload":{"type":"task_started"}}\nnot json\n')
      ctx.spec.env.FAKE_CODEX_ROLLOUT = bogus
      return ctx
    })(),
    // The app-server refuses the items.
    'inject refused': scopedHarness({ scenario: 'inject-fails', scope: 'shared', record }),
  }
  for (const [name, h0] of Object.entries(cases)) {
    const ctx = await build(h0)
    assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 0, `${name}: the old thread must never be resumed`)
    assert.equal(sentCalls(ctx.tracePath, 'thread/start').length, 1, `${name}: one fresh thread`)
    assert.equal(sentCalls(ctx.tracePath, 'thread/start')[0].developerInstructions, 'SHARED PROMPT', name)
    assert.equal(sentCalls(ctx.tracePath, 'thread/inject_items').length, name === 'inject refused' ? 1 : 0, name)
    assert.deepEqual(threadRecords(ctx.codexHome)['thread-abc'], { tools: '', scope: 'shared' }, name)
    await assertUsable(ctx)
    await ctx.driver.shutdownStop()
  }
})

test('a rebuild finds the rollout itself when thread/read fails (#1832)', async () => {
  const ctx = await build(scopedHarness({
    scenario: 'read-fails',
    scope: 'shared',
    record: { [FIXTURE.basic]: { tools: '', scope: 'member:alice' } },
  }))
  assert.equal(sentCalls(ctx.tracePath, 'thread/read').length, 1)
  assert.deepEqual(sentCalls(ctx.tracePath, 'thread/inject_items')[0].items.map(describe), BASIC_CONVERSATION)
  await ctx.driver.shutdownStop()
})

test('a rebuild whose fresh thread cannot start is a bad gateway (#1832)', async () => {
  await assert.rejects(
    () => build(scopedHarness({ scenario: 'start-fails', scope: 'shared', record: { [FIXTURE.basic]: { tools: '', scope: 'member:alice' } } })),
    (err) => err.status === 502 && /failed to start codex thread/.test(err.message),
  )
})

test('a reverted thread is rebuilt from its current rollout and the prefix it continues (#1832)', async () => {
  const ctx = await build(scopedHarness({
    scope: 'shared',
    resume: FIXTURE.revert,
    rollout: 'revert',
    record: { [FIXTURE.revert]: { tools: '', scope: 'member:alice' } },
  }))
  // The second turn was reverted; the first, with its tool call, remains.
  assert.deepEqual(sentCalls(ctx.tracePath, 'thread/inject_items')[0].items.map(describe), BASIC_CONVERSATION.slice(0, 4))
  await ctx.driver.shutdownStop()
})

test('the scope record stays bounded (#1832)', async () => {
  const record = {}
  for (let i = 0; i < 60; i++) record[`thread-${i}`] = { tools: '', scope: 'shared' }
  const ctx = await build(scopedHarness({ scope: 'shared', resume: '', rollout: null, record }))
  const kept = threadRecords(ctx.codexHome)
  assert.equal(Object.keys(kept).length, 50)
  assert.deepEqual(kept['thread-abc'], { tools: '', scope: 'shared' })
  assert.equal(kept['thread-0'], undefined, 'the oldest go first')
  await ctx.driver.shutdownStop()
})

test('the scope record evicts the thread used least recently, not the one recorded first (#1832)', async () => {
  const record = { 'thread-abc': { tools: '', scope: 'shared' } }
  for (let i = 0; i < 49; i++) record[`thread-${i}`] = { tools: '', scope: 'shared' }
  // thread-abc is the first recorded; this session resumes it, then one more
  // thread would push the record past its bound.
  const ctx = await build(scopedHarness({ scope: 'shared', resume: 'thread-abc', rollout: null, record }))
  let kept
  try {
    kept = threadRecords(ctx.codexHome)
    assert.equal(Object.keys(kept).at(-1), 'thread-abc', 'a resumed thread is the most recently used')
  } finally {
    await ctx.driver.shutdownStop()
  }
  const more = { ...kept, 'thread-new': { tools: '', scope: 'shared' } }
  const next = await build(scopedHarness({ scope: 'shared', resume: '', rollout: null, record: more }))
  try {
    const after = threadRecords(next.codexHome)
    assert.deepEqual(after['thread-abc'], { tools: '', scope: 'shared' }, 'the thread in use survives the bound')
    assert.equal(after['thread-0'], undefined)
  } finally {
    await next.driver.shutdownStop()
  }
})

test("a fresh thread after a failed resume is recorded for this session's scope (#1832)", async () => {
  // A legacy thread (scope unknown) resumes in a private chat. When it is
  // gone, the fresh thread is the member's, and must say so: recorded as
  // unknown, a later shared session would resume it rather than rebuild.
  const ctx = await build(scopedHarness({
    scenario: 'resume-fails',
    scope: 'member:alice',
    resume: 'thread-gone',
    rollout: null,
    record: { 'thread-gone': '' },
  }))
  try {
    assert.equal(sentCalls(ctx.tracePath, 'thread/resume').length, 1)
    assert.equal(sentCalls(ctx.tracePath, 'thread/start').length, 1)
    assert.deepEqual(threadRecords(ctx.codexHome)['thread-abc'], { tools: '', scope: 'member:alice' })
  } finally {
    await ctx.driver.shutdownStop()
  }
})

// ---- rollout reconstruction (#1832) -----------------------------------------

async function fixtureHistory(name) {
  const dir = join(ROLLOUTS, name, 'sessions', '2026', '10', '14')
  const files = readdirSync(dir)
  const path = join(dir, files.find((f) => f.includes('_')) ?? files[0])
  return codexRolloutHistory(await readCodexRolloutLineage(join(ROLLOUTS, name), path), FIXTURE[name])
}

test('a compacted thread carries its compaction, not the instructions written after it (#1832)', async () => {
  // Codex replaces the history with the compaction's replacement_history and
  // re-writes the developer message (Alice's, again) at the next turn.
  const dir = join(ROLLOUTS, 'compact', 'sessions', '2026', '10', '14')
  const raw = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')
  assert.equal(raw.split('ALICE-PRIVATE-MEMORY-7731').length - 1 >= 2, true, 'the fixture holds the instructions twice')
  const items = await fixtureHistory('compact')
  assert.deepEqual(items.map(describe), [
    'message:user:RUN-TOOL: draft the offer for ACME',
    'message:user:SECOND-TURN: make it more formal',
    `message:user:${SUMMARY_PREFIX}\nSUMMARY-8080: the user drafted an offer; echo ran; second turn made it formal.`,
    'message:user:THIRD-TURN-AFTER-COMPACT: add a deadline',
    'message:assistant:ack-5',
  ])
  for (const text of ALICE_TEXT) assert.ok(!JSON.stringify(items).includes(text), text)
})

test('a reverted thread reads through its history base (#1832)', async () => {
  const dir = join(ROLLOUTS, 'revert', 'sessions', '2026', '10', '14')
  const current = join(dir, readdirSync(dir).find((f) => f.includes('_')))
  const lineage = await readCodexRolloutLineage(join(ROLLOUTS, 'revert'), current)
  assert.equal(lineage.length, 2, 'the immutable prefix, then the current rollout')
  assert.deepEqual(codexRolloutHistory(lineage, FIXTURE.revert).map(describe), BASIC_CONVERSATION.slice(0, 4))
  // The current rollout alone holds none of the conversation.
  assert.deepEqual(codexRolloutHistory(readFileSync(current, 'utf8'), FIXTURE.revert), [])
})

// Rollout lines shaped like codex 0.160.0's, for what the recorded fixtures
// cannot show: thread_rolled_back (no 0.160.0 code path writes one; older
// pins and the TUI's backtrack did) and compactions in the older format.
const rl = (type, payload, extra = {}) => JSON.stringify({ timestamp: '2026-10-14T00:00:00.000Z', type, payload, ...extra })
const metaLine = (id, extra = {}) => rl('session_meta', {
  id, session_id: id, timestamp: '2026-10-14T00:00:00.000Z', cwd: '/home/agent/workspace',
  originator: 'zwrm-agentd', cli_version: '0.160.0', ...extra,
})
const ev = (type, fields = {}) => rl('event_msg', { type, ...fields })
const msgLine = (role, text, extra = {}) => rl('response_item', {
  type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }], ...extra,
})
const turnLines = (id, ...lines) => [
  ev('task_started', { turn_id: id }), rl('turn_context', { turn_id: id, cwd: '/home/agent/workspace' }),
  ...lines, ev('task_complete', { turn_id: id, last_agent_message: null }),
]
const item = (role, text) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] })
const DEV = msgLine('developer', 'ALICE-PRIVATE-MEMORY-7731')
const ENV = msgLine('user', '<environment_context>\n  <cwd>/home/agent/workspace</cwd>\n</environment_context>')
const SUMMARY = `${SUMMARY_PREFIX}\nSUMMARY`
const T = 'thread-synthetic'

function twoTurnsWithCompaction({ compaction = {}, mode } = {}) {
  return [
    metaLine(T, mode ? { history_mode: mode } : {}),
    ...turnLines('a', DEV, ENV, msgLine('user', 'A-MSG'), msgLine('assistant', 'A-REPLY')),
    ...turnLines('b',
      msgLine('user', 'B-MSG'),
      rl('response_item', { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'call_b' }),
      rl('response_item', { type: 'function_call_output', call_id: 'call_b', output: 'B-OUT' }),
      // A mid-turn compaction writes the developer message into its
      // replacement history.
      rl('compacted', {
        message: SUMMARY,
        replacement_history: [item('developer', 'ALICE-PRIVATE-MEMORY-7731'), item('user', 'A-MSG'), item('user', 'B-MSG'), item('user', SUMMARY)],
        ...compaction,
      }),
      msgLine('assistant', 'B-REPLY')),
  ]
}

test('a rollback undoes its turns, the compaction inside them included (#1832)', () => {
  // Older format: the compaction carries no window_number, so it bounds the
  // replay only if no rollback undid it. Here one did.
  const lines = [...twoTurnsWithCompaction(), ev('thread_rolled_back', { num_turns: 1 })]
  assert.deepEqual(codexRolloutHistory(lines.join('\n'), T).map(describe), ['message:user:A-MSG', 'message:assistant:A-REPLY'])

  // Not undone, the same compaction replaces the history before it.
  assert.deepEqual(codexRolloutHistory(twoTurnsWithCompaction().join('\n'), T).map(describe), [
    'message:user:A-MSG', 'message:user:B-MSG', `message:user:${SUMMARY}`, 'message:assistant:B-REPLY',
  ])
})

test('a compaction in the current format bounds the replay, and rollbacks after it apply to it (#1832)', () => {
  // window_number + resume_metadata (or a paginated thread) make the newest
  // compaction the base, even one inside a later rolled-back turn.
  const current = { window_number: 1, resume_metadata: { last_started_turn_id: 'b' } }
  const lines = [
    ...twoTurnsWithCompaction({ compaction: current }),
    ...turnLines('c', DEV, msgLine('user', 'C-MSG'), msgLine('assistant', 'C-REPLY')),
    ev('thread_rolled_back', { num_turns: 1 }),
  ]
  assert.deepEqual(codexRolloutHistory(lines.join('\n'), T).map(describe), [
    'message:user:A-MSG', 'message:user:B-MSG', `message:user:${SUMMARY}`, 'message:assistant:B-REPLY',
  ])

  const paginated = [...twoTurnsWithCompaction({ compaction: { window_number: 1 }, mode: 'paginated' }),
    ev('thread_rolled_back', { num_turns: 1 })]
  assert.deepEqual(codexRolloutHistory(paginated.join('\n'), T).map(describe), ['message:user:A-MSG'])
})

test('what codex does not keep, and the context it wrote, stay behind (#1832)', () => {
  const lines = [
    metaLine(T, { history_mode: 'paginated' }),
    ...turnLines('a',
      DEV,
      rl('response_item', { type: 'additional_tools', role: 'developer', tools: [{ name: 'old_tool' }] }),
      msgLine('system', 'SYSTEM-TEXT'),
      ENV,
      msgLine('user', '# AGENTS.md instructions for /home/agent\n\n<INSTRUCTIONS>\nALICE-AGENTS\n</INSTRUCTIONS>'),
      msgLine('user', '<skill>\n<name>alice-private-notes</name>\nALICE-SKILL-BODY\n</skill>'),
      msgLine('user', 'U-MSG'),
      rl('response_item', { type: 'ghost_snapshot', ghost_commit: {} }),
      rl('response_item', { type: 'custom_tool_call', call_id: 'ct1', name: 'apply_patch', input: '*** Begin Patch' }),
      rl('response_item', { type: 'custom_tool_call_output', call_id: 'ct1', output: 'Done' }),
      rl('response_item', { type: 'configuration_update', reasoning: { effort: 'high' } }, { metadata: { harness_authored_configuration: true } }),
      rl('response_item', {
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DELIVERED' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'a' },
      }, { metadata: { delivered_assistant_message: 'codex:code-mode-delivery:v1:complete', user_input_order: 1 } }),
      rl('response_item', { type: 'compaction', encrypted_content: 'ENC-COMPACTION' }),
      msgLine('user', '<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>'),
      msgLine('user', '<hook_prompt hook_run_id="run-1">HOOK TEXT</hook_prompt>'),
      msgLine('assistant', 'A-REPLY')),
    '{"type":"response_item","payload":{"type":"message","role":"user","con', // a write torn by a crash
  ]
  assert.deepEqual(codexRolloutHistory(lines.join('\n'), T).map(describe), [
    'message:user:U-MSG',
    'custom_tool_call::ct1',
    'custom_tool_call_output::ct1',
    'message:assistant:A-REPLY',
  ])
})

test('a remote compaction carries the plain messages it kept, never its encrypted item (#1832)', async () => {
  // The compaction request held Alice's developer message, and its encrypted
  // item is the server's encoding of that window: carried over, the shared
  // thread's model would read her instructions back out of it.
  const dir = join(ROLLOUTS, 'remote', 'sessions', '2026', '10', '14')
  const raw = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')
  assert.ok(raw.includes('"type":"compaction"'), 'the fixture holds an encrypted compaction')
  assert.ok(raw.includes('"retained_context"'), 'and the messages it retained')
  const items = await fixtureHistory('remote')
  assert.deepEqual(items.map(describe), [
    'message:user:RUN-TOOL: draft the offer',
    'message:assistant:after-tool-2: the command printed its marker',
    'message:user:AFTER-COMPACT: go on',
  ])
  const carried = JSON.stringify(items)
  for (const text of ALICE_TEXT) assert.ok(!carried.includes(text), text)
  assert.ok(!carried.includes('encrypted_content'), 'nothing encrypted')
  assert.ok(items.every((i) => i.id === undefined), 'no item ids')
})

// A remote compaction as codex 0.160.0 writes one: every user message kept
// whole in replacement_history, the rest in an encrypted item, and the
// replies retained as plain text (at most 8, each cut short), all numbered
// by one acceptance order.
const BRIEF = `BRIEF ${'details '.repeat(3000)}`
function remoteCompaction({ retained, metadata = true } = {}) {
  return [
    metaLine(T, { history_mode: 'paginated' }),
    ...turnLines('c', DEV, rl('compacted', {
      message: '',
      replacement_history: [item('user', BRIEF), item('user', 'U-2'), item('user', 'U-3'),
        { type: 'compaction', encrypted_content: 'ENC-REMOTE' }],
      ...(metadata ? { replacement_history_metadata: [{ user_input_order: 0 }, { user_input_order: 2 }, { user_input_order: 4 }, null] } : {}),
      retained_context: retained ?? {
        // The brief is past what retained_context keeps of the users.
        user_messages: [{ order: 2, text: 'U-2' }, { order: 4, text: 'U-3' }],
        user_messages_incomplete: true,
        assistant_messages: [
          { order: 5, text: 'A-3', phase: 'final_answer' },
          { order: 1, text: 'A-1', phase: 'final_answer' },
          { order: 3, text: 'A-2 (cut short)', phase: 'commentary' },
          { order: 6, text: '' },
        ],
      },
      window_number: 1,
      resume_metadata: { last_started_turn_id: 'c' },
    })),
    ...turnLines('d', DEV, ENV, msgLine('user', 'AFTER')),
  ].join('\n')
}

test('a remote compaction keeps every user message whole, with its replies in their order (#1832)', () => {
  const items = codexRolloutHistory(remoteCompaction(), T)
  assert.deepEqual(items.map(describe), [
    `message:user:${BRIEF}`,
    'message:assistant:A-1',
    'message:user:U-2',
    'message:assistant:A-2 (cut short)',
    'message:user:U-3',
    'message:assistant:A-3',
    'message:user:AFTER',
  ])
  assert.deepEqual(items[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A-1' }], phase: 'final_answer' })
  assert.equal(items[3].phase, 'commentary')
  const carried = JSON.stringify(items)
  assert.ok(!carried.includes('ENC-') && !carried.includes('ALICE'), carried.slice(0, 200))
})

test('a remote compaction with no replies retained still carries its user messages (#1832)', () => {
  const items = codexRolloutHistory(remoteCompaction({ retained: { user_messages: [], assistant_messages: [] } }), T)
  assert.deepEqual(items.map(describe), [`message:user:${BRIEF}`, 'message:user:U-2', 'message:user:U-3', 'message:user:AFTER'])
})

test('a remote compaction whose messages carry no order falls back to what it retained (#1832)', () => {
  const items = codexRolloutHistory(remoteCompaction({ metadata: false }), T)
  assert.deepEqual(items.map(describe), [
    'message:assistant:A-1', 'message:user:U-2', 'message:assistant:A-2 (cut short)',
    'message:user:U-3', 'message:assistant:A-3', 'message:user:AFTER',
  ])
})

test('a rebuild strips encrypted tool arguments and output parts (#1832)', () => {
  const lines = [
    metaLine(T, { history_mode: 'paginated' }),
    ...turnLines('a',
      msgLine('user', 'U-MSG', { id: 'msg_1' }),
      rl('response_item', { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC-R' }),
      rl('response_item', { type: 'function_call', id: 'fc_1', name: 'exec_command', arguments: '{"cmd":"ls"}', encrypted_function_args: ['ENC-ARGS'], call_id: 'c1' }),
      rl('response_item', { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'OUT' }, { type: 'encrypted_content', encrypted_content: 'ENC-OUT' }] }),
      rl('response_item', { type: 'context_compaction', id: 'cc_1', encrypted_content: 'ENC-CC' }),
      rl('response_item', { type: 'compaction_summary', encrypted_content: 'ENC-CS' }),
      rl('response_item', { type: 'agent_message', author: '/root/a', content: [{ type: 'encrypted_content', encrypted_content: 'ENC-AM' }] }),
      rl('response_item', { type: 'function_call', name: 'mcp__x__y', arguments: '{}', call_id: 'c2' }),
      rl('response_item', { type: 'function_call_output', call_id: 'c2', output: [{ type: 'encrypted_content', encrypted_content: 'ENC-ONLY' }] }),
      msgLine('assistant', 'A-REPLY', { id: 'msg_2' })),
  ]
  const items = codexRolloutHistory(lines.join('\n'), T)
  assert.deepEqual(items.map(describe), [
    'message:user:U-MSG', 'function_call::c1', 'function_call_output::c1',
    'function_call::c2', 'function_call_output::c2', 'message:assistant:A-REPLY',
  ])
  // An output that was all encrypted still answers its call, and says why.
  assert.match(items[4].output, /not carried over/)
  assert.ok(!JSON.stringify(items).includes('ENC-'), JSON.stringify(items))
  assert.ok(items.every((i) => i.id === undefined))
  assert.equal(items[1].arguments, '{"cmd":"ls"}')
  assert.deepEqual(items[2].output, [{ type: 'input_text', text: 'OUT' }])
})

test('a rollout that cannot be rebuilt faithfully is refused, not guessed at (#1832)', () => {
  const ok = [metaLine(T), ...turnLines('a', msgLine('user', 'A-MSG'))]
  assert.throws(() => codexRolloutHistory(ok.join('\n'), 'another-thread'), /not another-thread/)
  assert.throws(() => codexRolloutHistory(turnLines('a', msgLine('user', 'A-MSG')).join('\n'), T), /no session_meta/)
  assert.throws(() => codexRolloutHistory([metaLine(T, { history_mode: 'sharded' })].join('\n'), T), /history mode/)
  assert.throws(() => codexRolloutHistory([...ok, rl('compacted', { message: 'SUMMARY' })].join('\n'), T), /legacy compaction/)
  assert.throws(() => codexRolloutHistory([...ok, rl('inter_agent_communication', { author: '/root', recipient: '/root/a', content: 'x', trigger_turn: true })].join('\n'), T), /multi-agent/)
})

test('the context codex writes is told from what the user wrote (#1832)', () => {
  for (const text of [
    '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>',
    '  <ENVIRONMENT_CONTEXT>x</environment_context>\n',
    '# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\nhi\n</INSTRUCTIONS>',
    '<skill>\n<name>a</name>\n<path>/x/SKILL.md</path>\nbody\n</skill>',
    '<user_shell_command>x</user_shell_command>',
    '<turn_aborted>x</turn_aborted>',
    '<subagent_notification>x</subagent_notification>',
    '<agent_message_board_notification>x</agent_message_board_notification>',
    '<recommended_plugins>x</recommended_plugins>',
    '<external_slack>x</external_slack>',
    '<codex_internal_context source="goal_v2">x</codex_internal_context>',
    '<goal_context>x</goal_context>',
    '<hook_prompt hook_run_id="r1">x</hook_prompt>',
    'Warning: The maximum number of unified exec processes you can keep open is 8.',
  ]) assert.equal(isCodexContextualUserText(text), true, text)
  for (const text of [
    'hello',
    'please read the <skill> docs',
    '<environment_context> only opens',
    '<external_a>x</external_b>',
    '<hook_prompt hook_run_id="">x</hook_prompt>',
    '<codex_internal_context source="Bad">x</codex_internal_context>',
    `${SUMMARY_PREFIX}\nsummary`,
  ]) assert.equal(isCodexContextualUserText(text), false, text)
})
