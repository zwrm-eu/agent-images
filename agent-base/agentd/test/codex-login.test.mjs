// The codex ChatGPT login kept current by the control plane (#2328): the
// session runs on the platform's live copy, a renewal codex makes in the VM
// goes back, and nothing ever overwrites a newer login with an older one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexLoginSync, accountOf, codexLoginClient, newerLogin } from '../drivers/codex-login.mjs'

const login = (refresh, lastRefresh, account = 'acct-1') => ({
  auth_mode: 'chatgpt',
  tokens: { access_token: `at-${refresh}`, refresh_token: refresh, account_id: account, id_token: 'h.e30.s' },
  last_refresh: lastRefresh,
})

function fakeClient(state) {
  const calls = []
  return {
    calls,
    async fetch() {
      calls.push(['fetch'])
      if (state.error) throw state.error
      return { record: state.record, version: state.version }
    },
    async writeBack(version, record) {
      calls.push(['writeBack', version, record.tokens.refresh_token])
      if (version === state.version && newerLogin(record, state.record)) {
        state.record = record
        state.version++
      }
      return { record: state.record, version: state.version }
    },
  }
}

function rig(state, { onDisk } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codexlogin-'))
  const authPath = join(dir, 'auth.json')
  const markerPath = join(dir, '.zwrm-auth-source')
  if (onDisk) writeFileSync(authPath, JSON.stringify(onDisk) + '\n')
  const client = state ? fakeClient(state) : null
  let now = 1_000_000
  const sync = new CodexLoginSync({ client, authPath, markerPath, now: () => now })
  return {
    sync, client, authPath, markerPath,
    disk: () => JSON.parse(readFileSync(authPath, 'utf8')),
    marker: () => readFileSync(markerPath, 'utf8').trim().split(' '),
    later: (ms) => { now += ms },
  }
}

const BOOT = login('rt-boot', '2026-11-01T00:00:00Z')

test('a session runs on the platform\'s current login, not the copy it booted with', async () => {
  const state = { record: login('rt-live', '2026-11-19T10:00:00Z'), version: 4 }
  const r = rig(state)
  await r.sync.start(BOOT)
  assert.equal(r.disk().tokens.refresh_token, 'rt-live')
  assert.equal(r.marker()[0], 'OPENAI_CODEX_AUTH')
  assert.equal(r.marker()[2], '4')
})

test('a login codex renewed here after the platform\'s copy is kept and sent back', async () => {
  const state = { record: login('rt-live', '2026-11-19T10:00:00Z'), version: 4 }
  const r = rig(state, { onDisk: login('rt-vm', '2026-11-19T11:00:00Z') })
  await r.sync.start(BOOT)
  assert.equal(r.disk().tokens.refresh_token, 'rt-vm')
  assert.deepEqual(r.client.calls.at(-1), ['writeBack', 4, 'rt-vm'])
  assert.equal(state.record.tokens.refresh_token, 'rt-vm')
  assert.equal(r.marker()[2], '5')
})

test('an older login on disk is replaced; another account on disk is not kept', async () => {
  const state = { record: login('rt-live', '2026-11-19T10:00:00Z'), version: 1 }
  let r = rig(state, { onDisk: login('rt-old', '2026-11-02T00:00:00Z') })
  await r.sync.start(BOOT)
  assert.equal(r.disk().tokens.refresh_token, 'rt-live')
  r = rig(state, { onDisk: login('rt-mine', '2026-11-19T12:00:00Z', 'acct-other') })
  await r.sync.start(BOOT)
  assert.equal(r.disk().tokens.refresh_token, 'rt-live', 'the subscription secret decides, as before')
})

test('an expired login refuses the session; an unreachable platform falls back to the booted copy', async () => {
  const expired = Object.assign(new Error('The ChatGPT login has expired. Run codex login again.'), { status: 409 })
  let r = rig({ error: expired })
  await assert.rejects(r.sync.start(BOOT), (err) => err.status === 400 && err.codexLoginExpired && /codex login/.test(err.message))

  r = rig({ error: Object.assign(new Error('down'), { status: 503 }) })
  await r.sync.start(BOOT)
  assert.equal(r.disk().tokens.refresh_token, 'rt-boot')
  r = rig(null, { onDisk: login('rt-vm', '2026-11-19T11:00:00Z') })
  await r.sync.start(BOOT)
  assert.equal(r.disk().tokens.refresh_token, 'rt-vm', 'never overwrite a newer login with the booted copy')
})

test('after a turn: a renewal here goes back, a newer platform login comes in', async () => {
  const state = { record: login('rt-live', '2026-11-19T10:00:00Z'), version: 2 }
  const r = rig(state)
  await r.sync.start(BOOT)

  // Unchanged and recently synced: no call.
  const before = r.client.calls.length
  await r.sync.afterTurn()
  assert.equal(r.client.calls.length, before)

  // codex renewed it in the VM: it goes back over the version we had.
  writeFileSync(r.authPath, JSON.stringify(login('rt-vm', '2026-11-19T12:00:00Z')) + '\n')
  await r.sync.afterTurn()
  assert.deepEqual(r.client.calls.at(-1), ['writeBack', 2, 'rt-vm'])
  assert.equal(state.record.tokens.refresh_token, 'rt-vm')
  assert.equal(r.marker()[2], '3')

  // The platform renewed it meanwhile: the file picks it up once due.
  state.record = login('rt-cp', '2026-11-20T12:00:00Z')
  state.version = 4
  await r.sync.afterTurn()
  assert.equal(r.disk().tokens.refresh_token, 'rt-vm', 'not due yet')
  r.later(11 * 60_000)
  await r.sync.afterTurn()
  assert.equal(r.disk().tokens.refresh_token, 'rt-cp')
  assert.equal(r.marker()[2], '4')
})

test('a renewal made while the platform was out of reach still goes back', async () => {
  const state = { error: new Error('down') }
  const r = rig(state)
  await r.sync.start(BOOT)
  assert.equal(r.marker().length, 2, 'no version known')
  delete state.error
  state.record = BOOT
  state.version = 1
  writeFileSync(r.authPath, JSON.stringify(login('rt-vm', '2026-11-19T12:00:00Z')) + '\n')
  await r.sync.afterTurn()
  assert.equal(state.record.tokens.refresh_token, 'rt-vm')
})

test('a member\'s re-set login wins over a renewal here from the old one', async () => {
  const state = { record: login('rt-live', '2026-11-19T10:00:00Z'), version: 2 }
  const r = rig(state)
  await r.sync.start(BOOT)
  // A member re-ran codex login and set the secret anew (same account).
  state.record = login('rt-member', '2026-11-19T10:30:00Z')
  state.version = 3
  // Meanwhile codex renewed the old login in this VM, later still.
  writeFileSync(r.authPath, JSON.stringify(login('rt-vm', '2026-11-19T12:00:00Z')) + '\n')
  await r.sync.afterTurn()
  assert.equal(state.record.tokens.refresh_token, 'rt-member', 'the version check must stand')
})

test('a member signing in to another account here makes the file theirs', async () => {
  const state = { record: login('rt-live', '2026-11-19T10:00:00Z'), version: 2 }
  const r = rig(state)
  await r.sync.start(BOOT)
  writeFileSync(r.authPath, JSON.stringify(login('rt-own', '2026-11-19T12:00:00Z', 'acct-own')) + '\n')
  await r.sync.afterTurn()
  assert.equal(r.disk().tokens.refresh_token, 'rt-own')
  assert.equal(existsSync(r.markerPath), false)
  assert.equal(state.record.tokens.refresh_token, 'rt-live')
})

test('accountOf reads the id token when the record names no account', () => {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-jwt' } })).toString('base64url')
  assert.equal(accountOf({ tokens: { id_token: `h.${payload}.s` } }), 'acct-jwt')
  assert.equal(newerLogin(login('a', '2026-11-19T12:00:00Z'), login('b', '2026-11-19T12:00:00Z')), false)
})

test('the client calls the session\'s own endpoint through the broker', async () => {
  const seen = []
  const broker = {
    request: async (url, init, sessionID) => {
      seen.push({ url: String(url), method: init.method, sessionID, body: init.body })
      if (init.method === 'GET') return new Response(JSON.stringify({ record: BOOT, version: 3 }), { status: 200 })
      return new Response(JSON.stringify({ error: 'The ChatGPT login has expired' }), { status: 409 })
    },
  }
  const client = codexLoginClient(broker, { session_id: 's 1', callback_url: 'https://api.zwrm.eu/v1/internal/agent-sessions/s%201/events' })
  assert.deepEqual(await client.fetch(), { record: BOOT, version: 3 })
  assert.equal(seen[0].url, 'https://api.zwrm.eu/v1/internal/agent-sessions/s%201/codex-login')
  assert.equal(seen[0].sessionID, 's 1')
  await assert.rejects(client.writeBack(3, BOOT), (err) => err.status === 409 && /expired/.test(err.message))
  assert.deepEqual(JSON.parse(seen[1].body), { version: 3, record: BOOT })
  assert.equal(codexLoginClient(null, {}), null)
})
