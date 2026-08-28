import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ATTACHED_CONTEXT_MARKER, prepareMessage } from '../message-context.mjs'

test('prepareMessage adds validated workspace references without file contents', () => {
  const result = prepareMessage('Review this', [{
    id: 'a1', path: 'src/app.ts', name: 'app.ts', mime_type: 'text/typescript', size: 42, source: 'workspace',
  }])
  assert.match(result.prompt, /Review this/)
  assert.equal(result.text, 'Review this')
  assert.match(result.prompt, new RegExp(ATTACHED_CONTEXT_MARKER))
  assert.match(result.prompt, /src\/app\.ts/)
  assert.equal(result.attachments[0].path, 'src/app.ts')
})

test('prepareMessage keeps attachment-only turns free of synthetic user prose and rejects traversal', () => {
  const attachmentOnly = prepareMessage('', [{ path: 'README.md', size: 1 }])
  assert.equal(attachmentOnly.prompt.startsWith(ATTACHED_CONTEXT_MARKER), true)
  assert.equal(attachmentOnly.text, '')
  assert.doesNotMatch(attachmentOnly.prompt, /Use the attached/)
  assert.throws(() => prepareMessage('x', [{ path: '../secret', size: 1 }]), /invalid attachment/)
  assert.throws(() => prepareMessage('', []), /missing text/)
})

test('prepareMessage preserves visible text without requiring an attachment', () => {
  assert.deepEqual(prepareMessage('  Keep this visible  ', []), {
    prompt: 'Keep this visible',
    text: 'Keep this visible',
    attachments: [],
  })
})
