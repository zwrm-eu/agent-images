// Pure-shape tests for the opencode translators (#1391): the load-bearing
// consumers are applyEventMeta (resume handle, cumulative cost, completion
// gate) and the dashboard transcript parser — see the module header.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPENCODE_PROVIDER_ID,
  classifyOpenCodeError,
  gateInputFor,
  initPayload,
  isReservedMCPServer,
  partialPayload,
  questionAnswersFor,
  questionInputFor,
  resultPayload,
  textPayload,
  toolResultPayload,
  toolUsePayload,
  usagePayload,
} from '../drivers/opencode-translate.mjs'

test('initPayload carries the resume handle and names the harness', () => {
  assert.deepEqual(initPayload('ses_1', 'qwen-235b'),
    { type: 'system', subtype: 'init', session_id: 'ses_1', model: 'qwen-235b', harness: 'opencode' })
  assert.equal(initPayload(null, null).session_id, '')
})

test('the provider id matches what the seeded config must emit', () => {
  // build/opencode config rendering (#1392) keys the gateway provider by
  // this exact string; the prompt body names it on every turn.
  assert.equal(OPENCODE_PROVIDER_ID, 'zwrm')
})

test('partialPayload renders the delta the dashboard streams, and drops empties', () => {
  const p = partialPayload('abc')
  assert.equal(p.type, 'stream_event')
  assert.equal(p.event.type, 'content_block_delta')
  assert.deepEqual(p.event.delta, { type: 'text_delta', text: 'abc' })
  assert.equal(partialPayload(''), null)
  assert.equal(partialPayload(undefined), null)
})

test('tool_use and tool_result pair on the callID', () => {
  const part = { callID: 'c1', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } }
  const use = toolUsePayload(part, 'm')
  assert.equal(use.message.content[0].id, 'c1')
  assert.equal(use.message.content[0].name, 'bash')
  assert.deepEqual(use.message.content[0].input, { command: 'ls' })

  const done = toolResultPayload({ callID: 'c1', tool: 'bash', state: { status: 'completed', output: 'ok\n' } })
  assert.equal(done.message.content[0].tool_use_id, 'c1')
  assert.equal(done.message.content[0].content, 'ok\n')
  assert.equal(done.message.content[0].is_error, undefined)

  // The probed rejection shape: state error carries the server's canned text.
  const denied = toolResultPayload({ callID: 'c1', state: { status: 'error', error: 'The user rejected permission to use this specific tool call.' } })
  assert.equal(denied.message.content[0].is_error, true)
  assert.match(denied.message.content[0].content, /rejected permission/)
})

test('usage maps cache reads and writes separately (unlike codex)', () => {
  assert.deepEqual(usagePayload({ input: 10, output: 2, cache: { read: 3, write: 4 } }),
    { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })
  assert.equal(usagePayload(null), undefined)
})

test('resultPayload: cost rides through as given (cumulative is the caller contract)', () => {
  const r = resultPayload({ subtype: 'success', resultText: 'done', costUSD: 0.0031, tokens: { input: 1, output: 2, cache: {} }, durationMS: 42 })
  assert.equal(r.total_cost_usd, 0.0031)
  assert.equal(r.result, 'done')
  assert.equal(r.is_error, undefined)
  const e = resultPayload({ subtype: 'error_during_execution', resultText: 'boom' })
  assert.equal(e.is_error, true)
  assert.equal(e.total_cost_usd, 0)
})

test('gate input carries the concrete action and the always-patterns', () => {
  assert.deepEqual(
    gateInputFor({ permission: 'bash', metadata: { command: 'rm -rf x' }, patterns: ['rm *'] }),
    { command: 'rm -rf x', patterns: ['rm *'] })
  assert.deepEqual(gateInputFor({}), {})
})

test('textPayload renders a plain assistant block', () => {
  assert.deepEqual(textPayload('hi', 'm').message.content, [{ type: 'text', text: 'hi' }])
})

test('error taxonomy: auth, rate limit, crash, abort, default', () => {
  assert.equal(classifyOpenCodeError(new Error('401 Unauthorized from gateway')).cause, 'auth')
  assert.equal(classifyOpenCodeError(new Error('429 rate limit')).cause, 'rate_limited')
  assert.equal(classifyOpenCodeError(new Error('opencode serve exited (code 1)')).cause, 'crashed')
  assert.equal(classifyOpenCodeError({ name: 'MessageAbortedError', message: 'x' }).cause, 'error')
  assert.equal(classifyOpenCodeError(new Error('something else')).cause, 'error')
})

test('the reserved platform server slug is zwrm alone', () => {
  assert.equal(isReservedMCPServer('zwrm'), true)
  assert.equal(isReservedMCPServer('github'), false)
})

// ---- #1392 additions --------------------------------------------------------
import { GATED_PERMISSIONS, buildSessionConfig, canonicalOpenCodeToolName } from '../drivers/opencode-translate.mjs'

test('canonical names: longest slug wins, non-MCP names pass through', () => {
  const slugs = ['github', 'my_crm', 'zwrm']
  assert.equal(canonicalOpenCodeToolName('github_create_issue', slugs), 'mcp__github__create_issue')
  // A slug containing the separator must not be split at the wrong joint.
  assert.equal(canonicalOpenCodeToolName('my_crm_lookup', slugs), 'mcp__my_crm__lookup')
  assert.equal(canonicalOpenCodeToolName('zwrm_save_skill', slugs), 'mcp__zwrm__save_skill')
  assert.equal(canonicalOpenCodeToolName('bash', slugs), 'bash')
  assert.equal(canonicalOpenCodeToolName('sleep', slugs), 'sleep')
  assert.equal(canonicalOpenCodeToolName('github_x', []), 'github_x')
})

test('session config: platform base + native MCP entries + gate table', () => {
  const platform = { provider: { zwrm: { npm: 'x' } }, disabled_providers: ['opencode'], share: 'disabled' }
  const cfg = buildSessionConfig({
    platform,
    mcpServers: {
      github: { type: 'http', url: 'http://gw/mcp/github', headers: { Authorization: 'Bearer t' } },
      broken: { type: 'stdio' },
    },
    interactive: true,
    instructionsPath: '/tmp/x/instr.md',
  })
  assert.deepEqual(cfg.provider, platform.provider)
  assert.deepEqual(cfg.disabled_providers, ['opencode'])
  assert.deepEqual(cfg.mcp.github, { type: 'remote', url: 'http://gw/mcp/github', headers: { Authorization: 'Bearer t' }, enabled: true })
  assert.equal(cfg.mcp.broken, undefined)
  // Config-level so command-invoked turns are covered too (#1429): the
  // command endpoint has no per-call tools field. task stays ENABLED — the
  // #1388 hang was pinned to a dead-upstream MCP call, not the subagent, and
  // the mcp_timeout below is the fix.
  // Interactive sessions get the question tool (#1555): a human is on the
  // stream, and the driver round-trips question.asked through the platform.
  assert.deepEqual(cfg.tools, { question: true })
  // A dead connector upstream must not wedge the session (#1388): every MCP
  // call is bounded so it fails with a timeout error instead of hanging.
  assert.equal(cfg.experimental.mcp_timeout, 120000)
  // Every gated native tool asks, and every MCP server's tools ask — that is
  // what routes connector calls through the platform gate.
  for (const [k, v] of Object.entries(GATED_PERMISSIONS)) assert.equal(cfg.permission[k], v)
  assert.equal(cfg.permission['github_*'], 'ask')
  // Interactive sessions carry no run tools, so no allow entries for them.
  assert.equal(cfg.permission.sleep, undefined)
  assert.deepEqual(cfg.instructions, ['/tmp/x/instr.md'])
})

test('session config for runs allows the platform run tools', () => {
  const cfg = buildSessionConfig({ platform: null, mcpServers: {}, interactive: false })
  assert.equal(cfg.permission.sleep, 'allow')
  // Runs have nobody to answer a question: the tool stays off (#1555).
  assert.equal(cfg.tools.question, false)
  assert.equal(cfg.permission.sleep_until, 'allow')
  assert.equal(cfg.mcp, undefined)
  assert.equal(cfg.instructions, undefined)
})

test('run-tool wire names never canonicalize, even under a colliding slug', () => {
  // A connector slugged 'sleep' must not rewrite the platform run tools.
  assert.equal(canonicalOpenCodeToolName('sleep_until', ['sleep']), 'sleep_until')
  assert.equal(canonicalOpenCodeToolName('sleep', ['sleep']), 'sleep')
  // Its own genuine tools still canonicalize.
  assert.equal(canonicalOpenCodeToolName('sleep_check_alarm', ['sleep']), 'mcp__sleep__check_alarm')
})

// Live external-provider models ride the session spec (#1446) and merge into
// the seeded zwrm provider — adding to the boot seed, never mutating it, and
// never inventing a provider the seed lacks.
test('session config merges live ext/ models into the seeded provider without mutating it', () => {
  const platform = {
    provider: { zwrm: { npm: 'x', options: { baseURL: 'http://gw', apiKey: '{env:T}' }, models: { 'qwen/qwen3': { name: 'Qwen', tool_call: true } } } },
    disabled_providers: ['opencode'],
  }
  const snapshot = JSON.stringify(platform)
  const models = { 'ext/mine/foo': { name: 'Foo', limit: { context: 9000, output: 512 }, cost: { input: 0, output: 0 }, tool_call: true } }
  const cfg = buildSessionConfig({ platform, mcpServers: {}, interactive: true, models })
  assert.deepEqual(Object.keys(cfg.provider.zwrm.models).sort(), ['ext/mine/foo', 'qwen/qwen3'])
  assert.deepEqual(cfg.provider.zwrm.models['ext/mine/foo'], models['ext/mine/foo'])
  // Provider options (baseURL, token) survive the merge: ext/ models ride them.
  assert.deepEqual(cfg.provider.zwrm.options, platform.provider.zwrm.options)
  // The shared platform object is untouched.
  assert.equal(JSON.stringify(platform), snapshot)

  // A stale CP sends no models: the seed passes through unchanged.
  const same = buildSessionConfig({ platform, mcpServers: {}, interactive: true })
  assert.deepEqual(Object.keys(same.provider.zwrm.models), ['qwen/qwen3'])
  // Empty map: identical to absent.
  assert.deepEqual(Object.keys(buildSessionConfig({ platform, mcpServers: {}, interactive: true, models: {} }).provider.zwrm.models), ['qwen/qwen3'])
  // No seeded provider to merge into: nothing is invented.
  const bare = buildSessionConfig({ platform: { disabled_providers: ['opencode'] }, mcpServers: {}, interactive: true, models })
  assert.equal(bare.provider, undefined)
  // Non-object models are ignored, never thrown on.
  assert.deepEqual(Object.keys(buildSessionConfig({ platform, mcpServers: {}, interactive: true, models: ['ext/x/y'] }).provider.zwrm.models), ['qwen/qwen3'])
  assert.deepEqual(Object.keys(buildSessionConfig({ platform, mcpServers: {}, interactive: true, models: 'ext/x/y' }).provider.zwrm.models), ['qwen/qwen3'])
  // Every other key of the seeded provider (npm, name, options) survives untouched.
  const { models: _m, ...restSeeded } = platform.provider.zwrm
  const { models: _c, ...restMerged } = cfg.provider.zwrm
  assert.deepEqual(restMerged, restSeeded)
  // Live wins when the same ext/ key is in the seed and the live set (name/limits refresh).
  const seededExt = { provider: { zwrm: { npm: 'x', models: { 'ext/mine/foo': { name: 'Stale', tool_call: true } } } } }
  assert.equal(buildSessionConfig({ platform: seededExt, mcpServers: {}, interactive: true, models }).provider.zwrm.models['ext/mine/foo'].name, 'Foo')
  // A seeded provider with no models key still merges.
  assert.deepEqual(Object.keys(buildSessionConfig({ platform: { provider: { zwrm: { npm: 'x' } } }, mcpServers: {}, interactive: true, models }).provider.zwrm.models), ['ext/mine/foo'])
})

// The live flag makes the spec's catalog AUTHORITATIVE (#1446): seeded ext/
// entries are replaced, so a provider removed after boot disappears and an
// org that removed its last provider gets an empty external set — while the
// platform catalog is untouched. Without the flag the seed is kept (add-only).
test('session config: a live catalog replaces the seeded ext/ entries; without the flag it only adds', () => {
  const platform = {
    provider: { zwrm: { npm: 'x', options: { baseURL: 'http://gw', apiKey: '{env:T}' },
      models: { 'qwen/qwen3': { name: 'Qwen', tool_call: true }, 'ext/old/gone': { name: 'Gone', tool_call: true } } } },
  }
  const snapshot = JSON.stringify(platform)
  // Live + empty: the stale seeded ext/ entry is dropped, the catalog stays.
  const cleared = buildSessionConfig({ platform, mcpServers: {}, interactive: true, models: {}, catalogLive: true })
  assert.deepEqual(Object.keys(cleared.provider.zwrm.models), ['qwen/qwen3'])
  // Live + models: replaced, not merged with the stale entry.
  const replaced = buildSessionConfig({ platform, mcpServers: {}, interactive: true, models: { 'ext/new/one': { name: 'One', tool_call: true } }, catalogLive: true })
  assert.deepEqual(Object.keys(replaced.provider.zwrm.models).sort(), ['ext/new/one', 'qwen/qwen3'])
  // No flag (listing failed, or an older CP): the seed is kept and models only add.
  const kept = buildSessionConfig({ platform, mcpServers: {}, interactive: true, models: { 'ext/new/one': { name: 'One', tool_call: true } } })
  assert.deepEqual(Object.keys(kept.provider.zwrm.models).sort(), ['ext/new/one', 'ext/old/gone', 'qwen/qwen3'])
  // Live but no seeded provider: still nothing invented.
  assert.equal(buildSessionConfig({ platform: {}, mcpServers: {}, interactive: true, models: {}, catalogLive: true }).provider, undefined)
  // The shared platform object is untouched throughout.
  assert.equal(JSON.stringify(platform), snapshot)
})


test('questionInputFor assigns positional ids and the platform question shape (#1555)', () => {
  const input = questionInputFor({
    id: 'que_1',
    questions: [
      { question: 'A?', header: 'H', options: [{ label: 'x', description: 'dx' }, { label: 'y', description: '' }] },
      { question: 'B?', header: '', multiple: true, custom: false, options: [] },
      { question: 'C?', header: 'H3', options: [{ nope: true }, 'str', { label: '' }, { label: 'z' }] },
    ],
  })
  assert.deepEqual(input, {
    questions: [
      { id: 'q1', question: 'A?', header: 'H', options: [{ label: 'x', description: 'dx' }, { label: 'y', description: '' }], multiSelect: false },
      { id: 'q2', question: 'B?', header: '', options: [], multiSelect: true },
      { id: 'q3', question: 'C?', header: 'H3', options: [{ label: 'z' }], multiSelect: false },
    ],
  })
  assert.deepEqual(questionInputFor({}), { questions: [] })
})

test('questionAnswersFor maps id- or text-keyed answers onto ordered label arrays (#1555)', () => {
  const opt = (...labels) => labels.map((label) => ({ label, description: '' }))
  const qs = questionInputFor({ questions: [
    { question: 'A?', header: '', options: opt('x', 'y') },
    { question: 'B?', header: '', options: opt('y', 'z'), multiple: true },
    { question: 'C?', header: '', options: opt('a, b', 'c') },
  ] }).questions
  assert.deepEqual(questionAnswersFor(qs, { q1: 'x', 'B?': ['y', 'z'], q3: 'free text' }), [['x'], ['y', 'z'], ['free text']])
  // The dashboard joins a multi-select with ", ": unjoin only when every
  // piece is an option label; a label that itself contains ", " stays whole.
  assert.deepEqual(questionAnswersFor(qs, { q2: 'y, z', q3: 'a, b' }), [[], ['y', 'z'], ['a, b']])
  assert.deepEqual(questionAnswersFor(qs, { q2: 'y, something else' }), [[], ['y, something else'], []])
  // Unanswered → [] (OpenCode renders "Unanswered"); empty strings drop.
  assert.deepEqual(questionAnswersFor(qs, { q1: '', q3: ['', 'c', 7] }), [[], [], ['c']])
  // No answers object at all is not an answer: the caller rejects.
  assert.equal(questionAnswersFor(qs, undefined), null)
  assert.equal(questionAnswersFor(qs, 'x'), null)
  assert.equal(questionAnswersFor(qs, ['x']), null)
})
