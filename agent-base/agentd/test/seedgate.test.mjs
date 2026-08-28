// Seed gate tests (#1136): the sentinel protocol between the VM init's
// backgrounded volume seed and the daemon's harness spawn. The init side is
// pinned by build/init_seed_failure_test.go; this side pins how the daemon
// reads the markers — most importantly that 'failed' wins over 'seeding'
// (the failure marker is terminal for the boot) and that an unreadable /run
// fails open rather than refusing sessions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedState, waitSeedClear } from '../seedgate.mjs'

async function runDir(files = []) {
  const dir = await mkdtemp(join(tmpdir(), 'seedgate-'))
  for (const f of files) await writeFile(join(dir, f), '')
  return dir
}

test('seedState: no markers is clear', async () => {
  assert.equal(await seedState(await runDir(['resolv.conf', 'sshd.pid'])), 'clear')
})

test('seedState: seeding sentinel', async () => {
  assert.equal(await seedState(await runDir(['.zwrm-seeding--home-agent'])), 'seeding')
})

test('seedState: failed marker', async () => {
  assert.equal(await seedState(await runDir(['.zwrm-seed-failed--home-agent'])), 'failed')
})

test('seedState: failed wins over seeding — the marker is terminal', async () => {
  const dir = await runDir(['.zwrm-seeding--home-agent', '.zwrm-seed-failed--home-agent'])
  assert.equal(await seedState(dir), 'failed')
})

test('seedState: unreadable /run fails open', async () => {
  assert.equal(await seedState('/no/such/dir'), 'clear')
})

test('seedState: the seed-errs capture file is not a lifecycle marker', async () => {
  assert.equal(await seedState(await runDir(['.zwrm-seed-errs--home-agent'])), 'clear')
})

test('waitSeedClear resolves when the sentinel is removed mid-wait', async () => {
  const dir = await runDir(['.zwrm-seeding--home-agent'])
  const wait = waitSeedClear({ runDir: dir, pollMs: 10, maxMs: 5000 })
  setTimeout(() => rm(join(dir, '.zwrm-seeding--home-agent')), 40)
  assert.equal(await wait, 'clear')
})

test('waitSeedClear reports a failure that lands mid-wait', async () => {
  const dir = await runDir(['.zwrm-seeding--home-agent'])
  const wait = waitSeedClear({ runDir: dir, pollMs: 10, maxMs: 5000 })
  setTimeout(() => writeFile(join(dir, '.zwrm-seed-failed--home-agent'), ''), 40)
  assert.equal(await wait, 'failed')
})

test('waitSeedClear times out on a wedged seed', async () => {
  const dir = await runDir(['.zwrm-seeding--home-agent'])
  assert.equal(await waitSeedClear({ runDir: dir, pollMs: 10, maxMs: 50 }), 'timeout')
})

test('waitSeedClear stops when cancelled (superseded or ended session)', async () => {
  const dir = await runDir(['.zwrm-seeding--home-agent'])
  let calls = 0
  const st = await waitSeedClear({ runDir: dir, pollMs: 10, maxMs: 5000, cancelled: () => ++calls >= 2 })
  assert.equal(st, 'cancelled')
})
