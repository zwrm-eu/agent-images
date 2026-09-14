import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageReceipts } from '../message-receipts.mjs'

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'message-receipts-'))
  const directory = join(base, 'home', '.zwrm', 'message-receipts')
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return { directory, receipts: new MessageReceipts(directory, 'process-one') }
}
const payload = { text: 'Install this skill:', attachments: [] }

test('a lost HTTP acknowledgement retries without injecting another message', (t) => {
  const { receipts } = fixture(t)
  const inputs = []
  const send = () => receipts.accept('delivery-1', 'session-1', payload, () => { inputs.push(payload); return true })
  assert.equal(send().duplicate, false)
  assert.equal(send().duplicate, true)
  assert.equal(inputs.length, 1)
  assert.throws(() => receipts.accept('delivery-1', 'session-1', { text: 'changed' }, () => true), /payload_conflict/)
})

test('a second input reaches the working harness before the first completes', (t) => {
  const { receipts } = fixture(t)
  const inputs = []
  for (const [id, text] of [['intro', 'Install this skill:'], ['link', 'https://example.test/SKILL.md']]) {
    receipts.accept(id, 'session-1', { text, attachments: [] }, () => { inputs.push(text); return true })
  }
  assert.equal(inputs.length, 2)
  assert.deepEqual(receipts.complete('session-1'), ['intro', 'link'])
})

test('completed receipts survive a daemon restart and session replacement', (t) => {
  const { receipts, directory } = fixture(t)
  receipts.accept('delivery-1', 'session-1', payload, () => true)
  receipts.complete('session-1')
  const restarted = new MessageReceipts(directory, 'process-two')
  const receipt = restarted.accept('delivery-1', 'session-2', payload, () => assert.fail('duplicate execution'))
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.duplicate, true)
})

test('definitely rejected input can be delivered after restart', (t) => {
  const { receipts, directory } = fixture(t)
  assert.throws(() => receipts.accept('delivery-1', 'session-1', payload, () => false), /not accepting/)
  const restarted = new MessageReceipts(directory, 'process-two')
  assert.equal(restarted.accept('delivery-1', 'session-2', payload, () => true).status, 'accepted')
})

test('a crash at the harness boundary retains uncertainty instead of duplicating work', (t) => {
  const { receipts, directory } = fixture(t)
  assert.throws(() => receipts.accept('delivery-1', 'session-1', payload, () => { throw new Error('process died') }), /process died/)
  const restarted = new MessageReceipts(directory, 'process-two')
  assert.throws(() => restarted.accept('delivery-1', 'session-2', payload, () => assert.fail('unsafe replay')), /handoff_outcome_unknown/)
})

test('accepted but unfinished input is not silently forgotten on restart', (t) => {
  const { receipts, directory } = fixture(t)
  receipts.accept('delivery-1', 'session-1', payload, () => true)
  const restarted = new MessageReceipts(directory, 'process-two')
  assert.throws(() => restarted.accept('delivery-1', 'session-2', payload, () => assert.fail('unsafe replay')), /handoff_outcome_unknown/)
  assert.equal(restarted.read('delivery-1').status, 'accepted')
})

test('receipt write failure prevents handoff, and acknowledgement failure is recoverable', (t) => {
  const { receipts } = fixture(t)
  const save = receipts.save.bind(receipts)
  receipts.save = () => { throw new Error('disk unavailable') }
  assert.throws(() => receipts.accept('delivery-1', 'session-1', payload, () => assert.fail('unrecorded handoff')), /disk unavailable/)
  let writes = 0
  let deliveries = 0
  receipts.save = (record) => { if (++writes === 2) throw new Error('ack failed'); save(record) }
  assert.throws(() => receipts.accept('delivery-1', 'session-1', payload, () => { deliveries++; return true }), /ack failed/)
  receipts.save = save
  assert.equal(receipts.accept('delivery-1', 'session-1', payload, () => { deliveries++; return true }).duplicate, true)
  assert.equal(deliveries, 1)
})
