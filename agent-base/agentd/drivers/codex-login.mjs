// The codex ChatGPT login, kept current by the control plane (#2328).
//
// OPENAI_CODEX_AUTH is a whole ~/.codex/auth.json, and its refresh token is
// single use. Every chat is its own workspace, seeded from the same secret,
// so the first codex to refresh inside a VM spent the token for every other
// workspace, and within days new chats failed with "Your access token could
// not be refreshed". The control plane now owns the login
// (GET/POST /v1/internal/agent-sessions/{id}/codex-login): it renews it well
// before codex would, and keeps the rotated tokens in the secret.
//
// This side:
//  - at session start, takes the platform's current login instead of the
//    copy the VM booted with, unless codex renewed the one on disk after
//    it, in which case that one is kept and sent back;
//  - after each turn, sends back a login codex renewed here, and picks up
//    the platform's newer one, so the file codex re-reads on a 401 is the
//    live login.
// Without the platform (an older control plane, a network failure) it falls
// back to the booted copy, and never overwrites a newer login on disk.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const CODEX_LOGIN_SOURCE = 'OPENAI_CODEX_AUTH'

const digest = (text) => createHash('sha256').update(text).digest('hex')

function claims(jwt) {
  const part = typeof jwt === 'string' ? jwt.split('.')[1] : undefined
  if (!part) return {}
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) || {}
  } catch {
    return {}
  }
}

// accountOf is the ChatGPT account a login is for.
export function accountOf(record) {
  const t = record?.tokens
  if (typeof t?.account_id === 'string' && t.account_id) return t.account_id
  return claims(t?.id_token)?.['https://api.openai.com/auth']?.chatgpt_account_id || ''
}

function refreshedAt(record) {
  const ms = Date.parse(record?.last_refresh ?? '')
  return Number.isFinite(ms) ? ms : 0
}

// newerLogin: a was renewed after b, for the same account.
export function newerLogin(a, b) {
  const acct = accountOf(a)
  return Boolean(acct) && acct === accountOf(b) && refreshedAt(a) > refreshedAt(b)
}

// codexLoginClient talks to the control plane as the session's own identity
// (the credential broker adds it). null without a platform to talk to.
export function codexLoginClient(broker, spec) {
  if (!broker || !spec?.callback_url || !spec?.session_id) return null
  let url
  try {
    url = new URL(`/v1/internal/agent-sessions/${encodeURIComponent(spec.session_id)}/codex-login`, new URL(spec.callback_url).origin)
  } catch {
    return null
  }
  const call = async (init) => {
    const res = await broker.request(url, { ...init, signal: AbortSignal.timeout(30_000) }, spec.session_id)
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* reported below */ }
    if (!res.ok) {
      const e = new Error(body?.error || `the control plane answered ${res.status}`)
      e.status = res.status
      throw e
    }
    if (!body?.record || typeof body.record !== 'object' || !Number.isInteger(body.version)) {
      throw new Error('the control plane returned no login')
    }
    return { record: body.record, version: body.version }
  }
  return {
    fetch: () => call({ method: 'GET' }),
    writeBack: (version, record) => call({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, record }),
    }),
  }
}

// An expired login refuses the session with the fix; nothing else about
// the platform's answer does. 400, never 409: the control plane reads a 409
// from session create as a busy slot, and a run would retry it until its
// timeout without ever saying why.
function expiredError(err) {
  const e = new Error(err.message)
  e.status = 400
  e.codexLoginExpired = true
  return e
}

export class CodexLoginSync {
  // client: codexLoginClient() or null. authPath/markerPath: codex's
  // auth.json and the record of what the platform wrote there
  // ("SOURCE DIGEST VERSION", the revocation check reads the first two).
  constructor({ client, authPath, markerPath, log = () => {}, now = Date.now, minIntervalMs = 10 * 60_000 }) {
    this.client = client
    this.authPath = authPath
    this.markerPath = markerPath
    this.log = log
    this.now = now
    this.minIntervalMs = minIntervalMs
    this.lastSync = 0
    this.syncing = null
  }

  async readDisk() {
    try {
      const text = await readFile(this.authPath, 'utf8')
      return { text, record: JSON.parse(text) }
    } catch {
      return null
    }
  }

  async readMarker() {
    try {
      const [source, recorded, version] = (await readFile(this.markerPath, 'utf8')).trim().split(/\s+/)
      return { source, digest: recorded, version: Number.isInteger(Number(version)) && version ? Number(version) : null }
    } catch {
      return null
    }
  }

  async mark(text, version) {
    await writeFile(this.markerPath, `${CODEX_LOGIN_SOURCE} ${digest(text)}${version ? ` ${version}` : ''}\n`, { mode: 0o600 })
  }

  async write(record, version) {
    const text = JSON.stringify(record) + '\n'
    await mkdir(dirname(this.authPath), { recursive: true })
    await writeFile(this.authPath, text, { mode: 0o600 })
    await this.mark(text, version)
  }

  // start puts the login this session should run on into auth.json.
  // bootRecord is the (validated) OPENAI_CODEX_AUTH the VM booted with.
  // Throws only for a login OpenAI refused for good (status 409).
  async start(bootRecord) {
    let record = bootRecord
    let version = null
    if (this.client) {
      try {
        ;({ record, version } = await this.client.fetch())
      } catch (err) {
        if (err?.status === 409) throw expiredError(err)
        this.log(`codex: could not get the current ChatGPT login from the platform (${err?.message || err}); using the one this VM booted with`)
        record = bootRecord
      }
    }
    this.lastSync = this.now()
    const disk = await this.readDisk()
    if (disk && newerLogin(disk.record, record)) {
      // codex renewed the login here after the copy we have: it holds the
      // only live refresh token. Keep it, and send it back.
      if (this.client && version !== null) {
        try {
          const back = await this.client.writeBack(version, disk.record)
          if (newerLogin(back.record, disk.record)) return this.write(back.record, back.version)
          return this.mark(disk.text, back.version)
        } catch (err) {
          this.log(`codex: could not send the renewed ChatGPT login back (${err?.message || err})`)
        }
      }
      return this.mark(disk.text, version)
    }
    return this.write(record, version)
  }

  // afterTurn keeps the platform and auth.json in step: a login codex
  // renewed here goes back, a newer one from the platform comes in. Runs
  // after each turn and at the start of the next. Never throws; runs one at
  // a time.
  afterTurn() {
    if (!this.client || this.syncing) return this.syncing ?? Promise.resolve()
    this.syncing = this.sync().catch((err) => {
      this.log(`codex: ChatGPT login sync failed: ${err?.message || err}`)
    }).finally(() => { this.syncing = null })
    return this.syncing
  }

  async sync() {
    const marker = await this.readMarker()
    if (marker?.source !== CODEX_LOGIN_SOURCE) return
    const disk = await this.readDisk()
    if (!disk) return
    const changed = digest(disk.text) !== marker.digest
    if (!changed && this.now() - this.lastSync < this.minIntervalMs) return
    this.lastSync = this.now()
    let live = changed && marker.version !== null
      ? await this.client.writeBack(marker.version, disk.record)
      : await this.client.fetch()
    // A renewal made while the platform was out of reach (no version known)
    // goes over the version it has now. With a version known, a refusal
    // stands: a member re-set the login meanwhile, and theirs wins.
    if (marker.version === null && newerLogin(disk.record, live.record)) {
      live = await this.client.writeBack(live.version, disk.record)
    }
    if (accountOf(live.record) !== accountOf(disk.record)) {
      // Someone signed in to another account here themselves: the file is
      // theirs now, and the platform leaves it alone.
      if (changed) await rm(this.markerPath, { force: true })
      return
    }
    if (newerLogin(live.record, disk.record)) return this.write(live.record, live.version)
    return this.mark(disk.text, live.version)
  }
}
