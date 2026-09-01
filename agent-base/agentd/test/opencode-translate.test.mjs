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
  // command endpoint has no per-call tools field.
  assert.deepEqual(cfg.tools, { question: false })
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
