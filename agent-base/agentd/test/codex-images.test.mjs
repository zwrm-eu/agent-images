// Images from codex's built-in image tool (#2328): the imageGeneration thread
// item becomes a file in the deliverables folder and a Markdown image in the
// chat. Item shapes follow the app-server v2 schema of the pinned
// @openai/codex (`codex app-server generate-json-schema`, ImageGenerationThreadItem).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generatedImagePayload,
  imageGenerationFailureText,
  imageMessage,
  saveGeneratedImage,
} from '../drivers/codex-images.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function savedImage(name = 'ig_123.png') {
  const dir = tmp('codex-gen-')
  const file = join(dir, name)
  writeFileSync(file, PNG)
  return file
}

test('the saved file is copied into the folder under its generation id, the original kept', () => {
  const src = savedImage()
  const out = join(tmp('outputs-'), 'images')
  const dest = saveGeneratedImage({ type: 'imageGeneration', id: 'item-1', generationId: 'ig_123', status: 'completed', savedPath: src }, out)
  assert.equal(dest, join(out, 'ig_123.png'))
  assert.deepEqual(readFileSync(dest), PNG)
  assert.ok(existsSync(src), 'codex keeps its own copy for later edits')
})

test('a second image with the same id gets a numbered sibling, never an overwrite', () => {
  const out = tmp('outputs-')
  const item = { id: 'item-1', generationId: 'ig_1', status: 'completed', savedPath: savedImage() }
  const first = saveGeneratedImage(item, out)
  writeFileSync(first, 'the user edited this')
  const second = saveGeneratedImage(item, out)
  assert.equal(second, join(out, 'ig_1-2.png'))
  assert.equal(readFileSync(first, 'utf8'), 'the user edited this')
})

test('an inline image is written out when there is no saved file, or the saved one is gone', () => {
  const out = tmp('outputs-')
  const inline = PNG.toString('base64')
  const a = saveGeneratedImage({ id: 'item-a', status: 'completed', result: inline }, out)
  assert.equal(a, join(out, 'item-a.png'))
  assert.deepEqual(readFileSync(a), PNG)
  const b = saveGeneratedImage({ id: 'item-b', status: 'completed', savedPath: '/nonexistent/x.webp', result: inline }, out)
  assert.equal(b, join(out, 'item-b.webp'))
  assert.deepEqual(readFileSync(b), PNG)
})

test('ids cannot steer the path, and odd extensions fall back to png', () => {
  const out = tmp('outputs-')
  const dest = saveGeneratedImage({ id: '../../etc/passwd', status: 'completed', savedPath: savedImage('x.exe') }, out)
  assert.equal(dest, join(out, 'etc-passwd.png'))
})

test('an item with no image (a stored file id only) saves nothing', () => {
  assert.equal(saveGeneratedImage({ id: 'i', status: 'completed', fileId: 'file_1' }, tmp('outputs-')), null)
  assert.equal(imageMessage({ id: 'i', status: 'completed', fileId: 'file_1' }, tmp('outputs-'), 'gpt'), null)
})

test('the chat message is a Markdown image of the saved file, the prompt as alt text', () => {
  const p = generatedImagePayload('/home/agent/outputs/images/ig 1.png', { revisedPrompt: 'A bull [and] a bear\non a trading floor' }, 'gpt-6.1-sol')
  assert.deepEqual(p, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '![A bull and a bear on a trading floor](/home/agent/outputs/images/ig%201.png)' }],
      model: 'gpt-6.1-sol',
    },
    generated_image: { path: '/home/agent/outputs/images/ig 1.png', prompt: 'A bull [and] a bear\non a trading floor' },
  })
  assert.equal(generatedImagePayload('/a/b(1).png', {}, '').message.content[0].text, '![Generated image](/a/b%281%29.png)')
})

test('a plan limit says so, with its reset time', () => {
  const item = { id: 'i', status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: 1795046400 } }
  assert.equal(imageGenerationFailureText(item), "Image generation stopped: the ChatGPT plan's image limit is used up. It resets 2026-11-19 00:00 UTC.")
  const msg = imageMessage(item, tmp('outputs-'), 'm')
  assert.equal(msg.message.content[0].text, imageGenerationFailureText(item))
  assert.equal(imageGenerationFailureText({ id: 'i', status: 'completed' }), null)
  assert.equal(imageGenerationFailureText({ failure: { type: 'somethingNew' } }), 'Image generation failed.')
})
