// Unit tests for the pi → claude-stream-json translators (#1063). These run
// with `npm test` (node --test) and need no API key or pi runtime — the
// translators are pure. The shapes asserted here are load-bearing for
// applyEventMeta (Go) and the dashboard transcript parser; see
// drivers/pi-translate.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assistantPayload,
  classifyPiError,
  contentBlocks,
  initPayload,
  lastAssistantText,
  mapEffort,
  partialPayload,
  resultPayload,
  sumAssistantUsage,
  toolResultsPayload,
  usagePayload,
} from '../drivers/pi-translate.mjs'

test('initPayload carries the resume handle the CP round-trips', () => {
  const p = initPayload('/home/agent/.pi/agent/sessions/--home-agent--/x.jsonl', 'claude-sonnet-4-6')
  assert.equal(p.type, 'system')
  assert.equal(p.subtype, 'init')
  assert.equal(p.session_id, '/home/agent/.pi/agent/sessions/--home-agent--/x.jsonl')
  assert.equal(p.harness, 'pi')
})

test('contentBlocks maps pi text/thinking/toolCall to claude blocks', () => {
  const blocks = contentBlocks([
    { type: 'text', text: 'hello' },
    { type: 'thinking', thinking: 'hmm' },
    { type: 'toolCall', id: 'tc_1', name: 'bash', arguments: { command: 'ls' } },
    { type: 'mystery', whatever: true },
  ])
  assert.deepEqual(blocks, [
    { type: 'text', text: 'hello' },
    { type: 'thinking', thinking: 'hmm' },
    { type: 'tool_use', id: 'tc_1', name: 'bash', input: { command: 'ls' } },
  ])
})

test('assistantPayload produces the claude assistant message shape', () => {
  const p = assistantPayload({
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    model: 'claude-sonnet-4-6',
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
    stopReason: 'stop',
  })
  assert.equal(p.type, 'assistant')
  assert.equal(p.message.role, 'assistant')
  assert.deepEqual(p.message.content, [{ type: 'text', text: 'done' }])
  assert.deepEqual(p.message.usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  })
})

test('toolResultsPayload maps pi tool results to a claude user message', () => {
  const p = toolResultsPayload([
    { role: 'toolResult', toolCallId: 'tc_1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] },
  ])
  assert.equal(p.type, 'user')
  assert.deepEqual(p.message.content, [{ type: 'tool_result', tool_use_id: 'tc_1', content: 'ok' }])
})

test('partialPayload emits the exact shape partialTextDelta() reads', () => {
  // dashboard/src/lib/agentTranscript.ts: event.type === 'content_block_delta'
  // && event.delta?.type === 'text_delta'
  const p = partialPayload({ type: 'text_delta', contentIndex: 0, delta: 'tok' })
  assert.equal(p.type, 'stream_event')
  assert.equal(p.event.type, 'content_block_delta')
  assert.deepEqual(p.event.delta, { type: 'text_delta', text: 'tok' })
  // Non-text deltas render nothing.
  assert.equal(partialPayload({ type: 'thinking_delta', delta: 'x' }), null)
  assert.equal(partialPayload({ type: 'text_start' }), null)
  assert.equal(partialPayload(undefined), null)
})

test('resultPayload carries the applyEventMeta fields', () => {
  const p = resultPayload({
    resultText: 'summary',
    costUSD: 0.42,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    numTurns: 3,
    durationMS: 1234,
  })
  assert.equal(p.type, 'result')
  assert.equal(p.subtype, 'success')
  assert.equal(p.result, 'summary')
  assert.equal(p.total_cost_usd, 0.42)
  assert.equal(p.num_turns, 3)
})

test('resultPayload marks non-success turn outcomes as errors', () => {
  assert.equal(resultPayload({ subtype: 'error_during_execution', resultText: 'failed' }).is_error, true)
  assert.equal(resultPayload({ subtype: 'success', resultText: 'done' }).is_error, undefined)
})

test('lastAssistantText takes the final assistant text', () => {
  assert.equal(
    lastAssistantText([
      { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      { role: 'toolResult', toolCallId: 'x', content: [] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'y', name: 'bash', arguments: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
    ]),
    'final',
  )
  assert.equal(lastAssistantText([]), '')
})

test('classifyPiError buckets API failures', () => {
  assert.equal(classifyPiError(new Error('401 invalid x-api-key')).cause, 'auth')
  assert.equal(classifyPiError(new Error('429 rate_limit_error')).cause, 'rate_limited')
  assert.equal(classifyPiError(new Error('boom')).cause, 'error')
  // The humanized message, not a stack trace, is what the timeline renders.
  assert.ok(!classifyPiError(new Error('boom')).message.includes('\n'))
})

test('sumAssistantUsage totals a cycle, null without usage', () => {
  const total = sumAssistantUsage([
    { role: 'assistant', usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 } },
    { role: 'toolResult', toolCallId: 'x', content: [] },
    { role: 'assistant', usage: { input: 20, output: 15, cacheRead: 0, cacheWrite: 0 } },
  ])
  assert.deepEqual(total, { input: 30, output: 20, cacheRead: 1, cacheWrite: 2 })
  assert.equal(sumAssistantUsage([{ role: 'assistant' }]), null)
  assert.equal(sumAssistantUsage([]), null)
})

test('usagePayload and mapEffort handle absent values', () => {
  assert.equal(usagePayload(undefined), undefined)
  assert.equal(mapEffort('xhigh'), 'xhigh')
  assert.equal(mapEffort(''), undefined)
  assert.equal(mapEffort('bogus'), undefined)
})

// The taxonomy must name the vendor the failed request was FOR (#1149), and
// must not send an operator after a credential that was never involved. Since
// #1193 the VM holds no vendor key at all — a 401 is the session token, so the
// message must say so and never name a vendor key.
test('auth and billing errors name the provider that failed', () => {
  const auth = classifyPiError(new Error('401 invalid api key'), 'lyceum')
  assert.equal(auth.cause, 'auth')
  assert.ok(auth.message.includes('lyceum'), auth.message)
  assert.ok(!/API_KEY/.test(auth.message), auth.message)
  assert.ok(/session/i.test(auth.message), auth.message)

  const billing = classifyPiError(new Error('insufficient credit'), 'lyceum')
  assert.equal(billing.cause, 'billing')
  assert.ok(billing.message.includes('lyceum'), billing.message)
  assert.ok(!billing.message.includes('Anthropic'), billing.message)

  // Unknown provider: generic, never a guess at which key to rotate.
  const unknown = classifyPiError(new Error('401 invalid api key'))
  assert.ok(!/API_KEY/.test(unknown.message), unknown.message)
  assert.ok(!unknown.message.includes('undefined'), unknown.message)
})
