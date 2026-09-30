import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { byteRange, FREE_CHECK_BYTES, MIN_FREE_BYTES, UploadCounter, uploadBudget, volumeFullError } from '../workspace-files.mjs'

const MiB = 1024 * 1024

// upload streams chunks of chunkBytes through an UploadCounter into a sink.
async function upload(counter, chunks, chunkBytes = MiB) {
  const source = Readable.from(Array.from({ length: chunks }, () => Buffer.alloc(chunkBytes)))
  const sink = new Writable({ write(_chunk, _enc, cb) { cb() } })
  await pipeline(source, counter, sink)
  return counter.size
}

test('byteRange serves the head the control plane asks for and ignores every other form', () => {
  const size = 50 * 1024 * 1024
  assert.deepEqual(byteRange('bytes=0-65535', size), { start: 0, end: 65535 })
  assert.deepEqual(byteRange('bytes=0-65535', 10), { start: 0, end: 9 }, 'clamped to a short file')
  assert.deepEqual(byteRange('bytes=100-', 200), { start: 100, end: 199 })
  // Unsatisfiable or unsupported ranges fall back to the whole file.
  assert.equal(byteRange('bytes=0-65535', 0), null, 'an empty file has no byte 0')
  assert.equal(byteRange('bytes=300-400', 200), null)
  assert.equal(byteRange('bytes=10-5', 200), null)
  assert.equal(byteRange('bytes=-500', 200), null)
  assert.equal(byteRange('bytes=0-1,5-9', 200), null)
  assert.equal(byteRange('items=0-1', 200), null)
  assert.equal(byteRange(undefined, 200), null)
  assert.equal(byteRange('bytes=99999999999999999999-', 200), null)
})

test('uploadBudget keeps MIN_FREE_BYTES of the volume back', async () => {
  const stat = async () => ({ bavail: 1000, bsize: 1024 * 1024 })
  assert.equal(await uploadBudget('/home/agent', stat), 1000 * 1024 * 1024 - MIN_FREE_BYTES)
  const full = async () => ({ bavail: 10, bsize: 4096 })
  assert.ok(await uploadBudget('/home/agent', full) < 0)
  // The real statfs answers for a directory that exists.
  assert.equal(typeof await uploadBudget(tmpdir()), 'number')
})

test('volumeFullError is a 507 that says how much space is left', () => {
  const err = volumeFullError(100 * 1024 * 1024 - MIN_FREE_BYTES)
  assert.equal(err.status, 507)
  assert.match(err.message, /100 MiB free, 256 MiB is kept for the agent/)
  assert.match(volumeFullError(-MIN_FREE_BYTES - 1).message, /\(0 MiB free/)
})

test('UploadCounter refuses a keep_free upload once the volume is past the reserve', async () => {
  // Free space shrinks as the upload writes, the way ext4 reports it.
  let written = 0
  const freeBytes = MIN_FREE_BYTES + 10 * MiB
  const stat = async () => ({ bavail: freeBytes - written, bsize: 1 })
  const counter = new UploadCounter({ maxBytes: 100 * MiB, keepFree: true, root: '/home/agent', stat })
  counter.on('data', (chunk) => { written += chunk.length })
  // The whole body is read, so the client's request completes and it gets
  // the 507, but nothing past the refusal is written.
  assert.equal(await upload(counter, 40), 40 * MiB)
  assert.equal(counter.refused?.status, 507)
  assert.match(counter.refused.message, /workspace volume/)
  assert.ok(written <= 10 * MiB + FREE_CHECK_BYTES + MiB, `refused only after ${written / MiB} MiB`)
})

test('UploadCounter re-reads free space every FREE_CHECK_BYTES, so side-by-side uploads see each other', async () => {
  let calls = 0
  const stat = async () => { calls++; return { bavail: MIN_FREE_BYTES + 100 * MiB, bsize: 1 } }
  const counter = new UploadCounter({ maxBytes: 100 * MiB, keepFree: true, root: '/home/agent', stat })
  assert.equal(await upload(counter, 20), 20 * MiB)
  assert.equal(calls, Math.ceil(20 * MiB / FREE_CHECK_BYTES))
})

test('UploadCounter leaves platform writes to the reserve and still caps the file size', async () => {
  const stat = async () => { throw new Error('platform writes must not consult free space') }
  const counter = new UploadCounter({ maxBytes: 100 * MiB, root: '/home/agent', stat })
  assert.equal(await upload(counter, 3), 3 * MiB)
  const big = new UploadCounter({ maxBytes: 2 * MiB, root: '/home/agent', stat })
  await assert.rejects(upload(big, 3), (err) => err.status === 400 && err.message === 'file too large (max 2MB)')
})
