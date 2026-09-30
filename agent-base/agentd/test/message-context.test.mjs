import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ATTACHED_CONTEXT_MARKER, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, prepareMessage } from '../message-context.mjs'

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

test('prepareMessage accepts 100 attachments of up to 100 MiB and nothing past either cap', () => {
  assert.equal(MAX_ATTACHMENTS, 100)
  assert.equal(MAX_ATTACHMENT_BYTES, 100 * 1024 * 1024)
  const refs = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
    id: `a${i}`, path: `.zwrm/chat-attachments/s/a${i}/tender-${i}.pdf`, mime_type: 'application/pdf',
    size: MAX_ATTACHMENT_BYTES, source: 'upload',
  }))
  const result = prepareMessage('Prepare the bid', refs)
  assert.equal(result.attachments.length, 100)
  assert.equal(result.prompt.split('\n').filter((line) => line.startsWith('- ')).length, 100)
  assert.throws(() => prepareMessage('x', [...refs, { path: 'one-more.pdf', size: 1 }]), /too many attachments/)
  assert.throws(() => prepareMessage('x', [{ path: 'huge.pdf', size: MAX_ATTACHMENT_BYTES + 1 }]), /invalid attachment/)
})
