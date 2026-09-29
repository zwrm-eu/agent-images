// VM identity lives in the host-attested metadata channel. The broker renews
// credentials; harness configurations receive session-bound loopback URLs.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_REQUEST = 32 * 1024 * 1024
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'cookie', 'x-api-key', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']

const EXPIRY_MARGIN_MS = 30_000

// One identity channel per audience: the CLI never receives the session's
// callback/connector bearer. Each channel coalesces and backs off renewal.
class RenewableIdentity {
  constructor(broker, sessionID) {
    this.broker = broker
    this.sessionID = sessionID
    this.credential = null
    this.renewing = null
    this.retryAt = 0
    this.failures = 0
    // Renewals the control plane refused in a row, stamped on each refusal
    // as err.refusals: callers tell a wake's passing refusal from revocation
    // by how long it lasts (#1664), and a refusal served again from backoff
    // must not count twice.
    this.refused = 0
    this.lastError = null
    this.closed = false
  }

  usable() { return this.credential && this.broker.now() < this.credential.expiresAt }

  async get({ rejected = false, fresh = false } = {}) {
    if (this.closed || this.broker.closed) throw new Error('credential session is no longer active')
    // A 401 is stronger than our local clock; never reuse that bearer.
    if (rejected) this.credential = null
    if (!fresh && !rejected && this.credential && this.broker.now() < this.credential.renewAt) return this.credential.token
    if (!this.renewing && this.broker.now() >= this.retryAt) {
      const pending = this.renew()
      this.renewing = pending
      // Keep error handling in each caller: strict CLI freshness cannot
      // inherit a proxy caller's valid-token fallback through a shared promise.
      void pending.finally(() => { if (this.renewing === pending) this.renewing = null }).catch(() => {})
    }
    try {
      if (this.renewing) return await this.renewing
      throw this.lastError || new Error('identity renewal is backing off')
    } catch (err) {
      if (!this.closed && !fresh && this.usable()) return this.credential.token
      throw err
    }
  }

  async renew() {
    const path = `/agent/identity/${encodeURIComponent(this.broker.machineID)}${this.sessionID ? '/' + encodeURIComponent(this.sessionID) : ''}`
    try {
      const res = await this.broker.fetch(new URL(path, this.broker.metadataURL), { redirect: 'error', signal: AbortSignal.timeout(10_000) })
      if (!res.ok) { const error = new Error(`metadata identity renewal refused (${res.status}): ${(await res.text()).slice(0, 500)}`); error.status = res.status; throw error }
      const next = await res.json()
      const lifetime = (next.expires_at - next.issued_at) * 1000
      if (typeof next.token !== 'string' || !next.token.startsWith('zwai1.') || !Number.isFinite(next.issued_at) || !Number.isFinite(next.expires_at) || lifetime <= EXPIRY_MARGIN_MS || lifetime > 3600_000) throw new Error('metadata returned an invalid identity credential')
      if (this.closed || this.broker.closed) throw new Error('identity changed during renewal')
      // Anchor the CP's signed lifetime to receipt, not the guest's absolute
      // wall clock. A 30s margin also covers metadata transport latency.
      const now = this.broker.now()
      this.credential = { token: next.token, renewAt: now + lifetime / 2, expiresAt: now + lifetime - EXPIRY_MARGIN_MS }
      this.retryAt = 0
      this.failures = 0
      this.refused = 0
      if (this.lastError) this.broker.diagnostic('identity renewal recovered', true)
      this.lastError = null
      return next.token
    } catch (err) {
      if (!this.closed && !this.broker.closed) {
        // Revocation must be immediate even if the old token has time left.
        if ([400, 401, 403, 404, 410].includes(err.status)) {
          this.credential = null
          err.refusals = ++this.refused
        } else {
          this.refused = 0
        }
        if (!this.lastError) this.broker.diagnostic(String(err.message || err), false)
        this.lastError = err
        this.retryAt = this.broker.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5))
      }
      throw err
    }
  }

  close() { this.closed = true; this.credential = null }
}

export class CredentialBroker {
  constructor({ metadataURL, machineID, platformURL, fetchImpl = fetch, now = Date.now, diagnostic = () => {} }) {
    this.metadataURL = new URL(metadataURL)
    this.platformURL = new URL(platformURL)
    if (!['http:', 'https:'].includes(this.metadataURL.protocol) || !['http:', 'https:'].includes(this.platformURL.protocol)) throw new Error('identity endpoints must be HTTP(S)')
    this.machineID = machineID
    this.fetch = fetchImpl
    this.now = now
    this.diagnostic = diagnostic
    this.sessionID = ''
    this.workspaceIdentity = new RenewableIdentity(this, '')
    this.sessionIdentity = null
    this.routes = new Map()
    this.lastCheck = now()
    this.closed = false
  }

  async start(port = 9925) {
    // A stable endpoint lets the CLI and SSH-started harnesses find the broker.
    // Session proxies use a random port and unguessable per-session route.
    this.server = createServer((req, res) => { void this.handle(req, res, false) })
    this.proxy = createServer((req, res) => { void this.handle(req, res, true) })
    const listen = (server, port) => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    await listen(this.server, port)
    try { await listen(this.proxy, 0) } catch (err) { await this.close(); throw err }
    this.url = `http://127.0.0.1:${this.server.address().port}`
    this.proxyURL = `http://127.0.0.1:${this.proxy.address().port}`
    this.timer = setInterval(() => { void this.tick() }, 15_000)
    this.timer.unref()
    // Binding is independent of metadata readiness. The first consumer waits
    // for renewal; a temporary metadata outage cannot prevent daemon startup.
    void this.get().catch(() => {})
    return this
  }

  async tick() {
    const now = this.now()
    const woke = now - this.lastCheck > 45_000 || now < this.lastCheck
    this.lastCheck = now
    if (woke) {
      this.workspaceIdentity.close()
      this.workspaceIdentity = new RenewableIdentity(this, '')
      this.sessionIdentity?.close()
      this.sessionIdentity = this.sessionID ? new RenewableIdentity(this, this.sessionID) : null
    }
    try { await this.get() } catch { /* renewal emits transition diagnostics */ }
  }

  async get(sessionID = this.sessionID, rejected = false) {
    if (sessionID === '') return this.workspaceIdentity.get({ rejected })
    if (sessionID !== this.sessionID || !this.sessionIdentity) throw new Error('credential session is no longer active')
    return this.sessionIdentity.get({ rejected })
  }

  // No bearer or mutable header object crosses the harness boundary.
  async activate(spec) {
    this.sessionIdentity?.close()
    this.sessionID = spec.session_id
    this.sessionIdentity = new RenewableIdentity(this, this.sessionID)
    this.routes.clear()
    await this.get()
    const root = '/' + randomUUID()
    const servers = {}
    for (const [name, cfg] of Object.entries(spec.mcp_servers || {})) {
      const target = new URL(cfg.url)
      if (target.origin !== this.platformURL.origin || target.username || target.password) throw new Error('connector URL is outside the platform')
      const route = `${root}/mcp/${encodeURIComponent(name)}`
      this.routes.set(route, { url: target, sessionID: this.sessionID })
      servers[name] = { ...cfg, url: this.proxyURL + route }
      delete servers[name].headers
    }
    const gateway = `${root}/gateway`
    this.routes.set(gateway + '/chat/completions', { url: new URL('/v1/openai/chat/completions', this.platformURL), sessionID: this.sessionID })
    return { ...spec, mcp_servers: servers, gateway_url: this.proxyURL + gateway, env: { ...spec.env, ZWRM_GATEWAY_TOKEN: 'broker' } }
  }

  deactivate(sessionID) {
    if (this.sessionID !== sessionID) return
    this.sessionIdentity?.close()
    this.sessionIdentity = null
    this.sessionID = ''
    this.routes.clear()
    void this.get().catch(() => {})
  }

  async request(url, init = {}, sessionID = this.sessionID) {
    const target = new URL(url)
    if (target.origin !== this.platformURL.origin || target.username || target.password) throw new Error('credential destination is outside the platform')
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.get(sessionID, attempt > 0)
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${token}`)
      const res = await this.fetch(target, { ...init, headers, redirect: 'manual' })
      if (res.status !== 401 || attempt === 1) return res
      await res.body?.cancel()
    }
  }

  async handle(req, res, sessionProxy) {
    try {
      // Reject browser-origin requests and DNS rebinding to the local broker.
      const expected = sessionProxy ? this.proxyURL : this.url
      if (req.headers.origin || req.headers.host !== new URL(expected).host) { res.writeHead(403).end(); return }
      const path = new URL(req.url, expected)
      if (!sessionProxy && path.pathname === '/token' && req.method === 'GET') {
        // A fresh workspace-only identity per CLI invocation also handles
        // restores on hosts whose guest clock has not caught up. Do not
        // return a cached token if metadata cannot establish freshness.
        const token = await this.workspaceIdentity.get({ fresh: true })
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ token }))
        return
      }
      let route = sessionProxy ? this.routes.get(path.pathname) : null
      if (!sessionProxy && path.pathname === '/gateway/chat/completions') route = { url: new URL('/v1/openai/chat/completions', this.platformURL), sessionID: '' }
      if (!route || !['GET', 'POST', 'DELETE'].includes(req.method)) { res.writeHead(404).end(); return }
      if (path.search) { res.writeHead(400).end(); return }
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (!HOP_HEADERS.includes(key) && key !== 'content-length' && value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      const chunks = []
      let length = 0
      for await (const chunk of req) { length += chunk.length; if (length > MAX_REQUEST) { res.writeHead(413).end(); return }; chunks.push(chunk) }
      const controller = new AbortController()
      res.once('close', () => { if (!res.writableEnded) controller.abort() })
      const upstream = await this.request(route.url, { method: req.method, headers, ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks) }), signal: controller.signal }, route.sessionID)
      // Redirects must never send a harness or bearer to an untrusted origin.
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); throw new Error('platform proxy refused a redirect') }
      const responseHeaders = {}
      upstream.headers.forEach((value, key) => { if (!HOP_HEADERS.includes(key) && !['content-encoding', 'content-length', 'set-cookie'].includes(key)) responseHeaders[key] = value })
      res.writeHead(upstream.status, responseHeaders)
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res)
      else res.end()
    } catch (err) {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(err.message || err) })) }
      else res.destroy()
    }
  }

  async close() {
    this.closed = true
    clearInterval(this.timer)
    this.workspaceIdentity.close()
    this.sessionIdentity?.close()
    await Promise.all([this.server, this.proxy].filter(Boolean).map(s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve) })))
  }
}
