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
