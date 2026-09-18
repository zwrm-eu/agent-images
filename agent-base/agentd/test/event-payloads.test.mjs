import assert from 'node:assert/strict'
import test from 'node:test'
import { contextTokensFromUsage, contextUsagePayload, permissionDecisionPayload } from '../event-payloads.mjs'

test('permission decisions durably retain updated input and question answers', () => {
  const updatedInput = {
    questions: [{ question: 'Deploy where?' }],
    answers: { 'Deploy where?': 'Production' },
  }
  assert.deepEqual(permissionDecisionPayload('request-1', {
    behavior: 'allow',
    message: 'approved',
    updated_input: updatedInput,
  }), {
    request_id: 'request-1',
    behavior: 'allow',
    message: 'approved',
    updated_input: updatedInput,
    answers: { 'Deploy where?': 'Production' },
  })
})

test('legacy decisions keep their compact v1-compatible shape', () => {
  assert.deepEqual(permissionDecisionPayload('request-2', { behavior: 'deny' }), {
    request_id: 'request-2',
    behavior: 'deny',
  })
})

test('null updated input is omitted from cancellation decisions', () => {
  assert.deepEqual(permissionDecisionPayload('request-3', {
    behavior: 'cancel',
    message: 'interrupted',
    updated_input: null,
  }), {
    request_id: 'request-3',
    behavior: 'cancel',
    message: 'interrupted',
  })
})

test('contextUsagePayload reports tokens, and the window when known (#1553)', () => {
  assert.deepEqual(contextUsagePayload(84_000, 200_000), { tokens: 84000, window: 200000 })
  assert.deepEqual(contextUsagePayload(1234.6), { tokens: 1235 })
  assert.equal(contextUsagePayload(0, 200_000), null)
  assert.equal(contextUsagePayload(undefined, 200_000), null)
})

test('contextTokensFromUsage sums the normalized usage shape (#1553)', () => {
  assert.equal(contextTokensFromUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 70, cache_creation_input_tokens: 15 }), 100)
  assert.equal(contextTokensFromUsage({ input_tokens: 10 }), 10)
  assert.equal(contextTokensFromUsage(undefined), undefined)
})
