import assert from 'node:assert/strict'
import test from 'node:test'
import { contextTokensFromUsage, contextUsagePayload, decisionForRequest, permissionDecisionPayload } from '../event-payloads.mjs'

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

test('a decision on a request that went out truncated runs the original input (#1631)', () => {
  // The client saw a truncated copy of the Write; echoing it back must not
  // write the truncated content.
  const write = { toolName: 'Write', input: { file_path: 'a.txt', content: 'the whole file' } }
  const echoed = { behavior: 'allow', updated_input: { file_path: 'a.txt', content: 'the who…[truncated 7 bytes]' } }
  assert.deepEqual(decisionForRequest(write, echoed, true), { behavior: 'allow' })
  assert.equal(echoed.updated_input.content, 'the who…[truncated 7 bytes]', 'the body is not mutated')
  // An untruncated request takes the client's edit as before, as the same object.
  assert.equal(decisionForRequest(write, echoed, false), echoed)
  // A question's answers ride updated_input, and drivers read only those.
  const question = { toolName: 'AskUserQuestion', kind: 'question', input: { questions: [] } }
  const answered = { behavior: 'allow', updated_input: { answers: { q1: 'yes' } } }
  assert.equal(decisionForRequest(question, answered, true), answered)
  // Nothing to drop.
  const deny = { behavior: 'deny', message: 'no' }
  assert.equal(decisionForRequest(write, deny, true), deny)
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
