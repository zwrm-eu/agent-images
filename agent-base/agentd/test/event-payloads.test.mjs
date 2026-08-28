import assert from 'node:assert/strict'
import test from 'node:test'
import { permissionDecisionPayload } from '../event-payloads.mjs'

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
