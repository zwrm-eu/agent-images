import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { CredentialBroker } from '../credential-broker.mjs'
import { EventPusher, MAX_RENEWAL_REFUSALS } from '../event-pusher.mjs'

async function environment(t) {
  const state = { now: Date.now(), minted: 0, renewalRequests: [], cpNow: null, renewalStatus: 0, accepted: [], rejectNext: false, denyRenewal: false, diagnostics: [] }
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/agent/identity/')) {
      state.renewalRequests.push(req.url)
      if (state.renewalStatus) { res.writeHead(state.renewalStatus).end('metadata unavailable'); return }
      if (state.denyRenewal) { res.writeHead(403).end('workspace deleted'); return }
      state.minted++
      const issued_at = Math.floor((state.cpNow ?? state.now) / 1000)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ token: `zwai1.test.${state.minted}`, issued_at, expires_at: issued_at + 3600 }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (state.rejectNext) { state.rejectNext = false; res.writeHead(401).end('expired'); return }
    state.accepted.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() })
    if (req.url === '/v1/openai/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      setTimeout(() => res.end('data: [DONE]\n\n'), 10)
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const broker = await new CredentialBroker({ metadataURL: url, platformURL: url, machineID: 'machine', now: () => state.now, diagnostic: (message, recovered) => state.diagnostics.push({ message, recovered }) }).start(0)
  t.after(async () => { await broker.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await broker.get()
  const spec = { session_id: 'session', mcp_servers: { zwrm: { type: 'http', url: url + '/v1/agents/agent/sessions/session/mcp', headers: { authorization: 'old' } }, connector: { type: 'http', url: url + '/v1/mcp/org/connector' } } }
  return { state, broker, spec, url }
}

for (const harness of ['claude', 'pi', 'codex', 'opencode']) {
  test(`${harness}: serialized MCP/gateway config works beyond 24h without a bearer`, async t => {
    const { state, broker, spec } = await environment(t)
    const child = JSON.parse(JSON.stringify(await broker.activate({ ...spec, harness })))
    for (const cfg of Object.values(child.mcp_servers)) assert.equal(cfg.headers, undefined)
    assert.equal(JSON.stringify(child).includes('zwai1.'), false)
    assert.equal(child.env.ZWRM_GATEWAY_TOKEN, 'broker')
    const call = async url => { const r = await fetch(url, { method: 'POST', body: '{"call":1}' }); assert.equal(r.status, 200); return r.text() }
    await call(child.mcp_servers.zwrm.url)
    const old = state.accepted.at(-1).auth
    state.now += 25 * 3600_000
    await Promise.all([call(child.mcp_servers.zwrm.url), call(child.mcp_servers.connector.url), call(child.gateway_url + '/chat/completions')])
    assert.notEqual(state.accepted.at(-1).auth, old)
    assert.ok(state.accepted.slice(-3).every(x => x.auth === state.accepted.at(-1).auth), 'concurrent callers share a renewal')
    assert.equal(state.accepted.at(-1).body, '{"call":1}')
    const cli = await (await fetch(broker.url + '/token')).json()
    assert.notEqual(`Bearer ${cli.token}`, state.accepted.at(-1).auth)
    assert.equal(state.renewalRequests.at(-1), '/agent/identity/machine', 'CLI must never request session authority')
    broker.deactivate(spec.session_id)
    assert.equal((await fetch(child.mcp_servers.zwrm.url)).status, 404, 'ended session cannot reuse its proxy')
  })
}

test('renews at half-life, on snapshot wake, and once on a 401; streams complete', async t => {
  const { state, broker, spec } = await environment(t)
  const child = await broker.activate(spec)
  let minted = state.minted
  state.now += 1800_000
  await broker.get()
  assert.equal(state.minted, ++minted)
  state.now += 60_000
  await broker.tick()
  assert.equal(state.minted, ++minted, 'clock gap invalidates the snapshot credential')
  state.rejectNext = true
  const response = await fetch(child.gateway_url + '/chat/completions', { method: 'POST', body: 'completion' })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /data: first\n\ndata: \[DONE\]/)
  assert.equal(state.minted, ++minted)
  assert.equal(state.accepted.at(-1).body, 'completion')
})

test('renewal denial surfaces the control-plane reason; never uses an expired token', async t => {
  const { state, broker, spec } = await environment(t)
  const child = await broker.activate(spec)
  state.denyRenewal = true
  state.now += 25 * 3600_000
  const r = await fetch(child.mcp_servers.zwrm.url, { method: 'POST', body: '{}' })
  assert.equal(r.status, 502)
  assert.match(await r.text(), /workspace deleted/)
  assert.ok(state.diagnostics.some(x => x.message.includes('workspace deleted')))
  assert.equal(state.accepted.length, 0)
})

test('proxy rejects foreign destinations, browser requests, rebinding and stale session URLs', async t => {
  const { broker, spec } = await environment(t)
  const first = await broker.activate(spec)
  assert.equal((await fetch(broker.url + '/token', { headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal(await new Promise((resolve, reject) => { const req = request(broker.url + '/token', { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) }); req.on('error', reject); req.end() }), 403)
  await assert.rejects(broker.request('http://evil.example/'), /outside the platform/)
  const second = await broker.activate({ ...spec, session_id: 'session2' })
  assert.notEqual(first.gateway_url, second.gateway_url)
  assert.equal((await fetch(first.mcp_servers.zwrm.url)).status, 404)
  await assert.rejects(broker.get('session'), /no longer active/)
  await assert.rejects(broker.activate({ ...spec, mcp_servers: { evil: { url: 'https://evil.example/' } } }), /outside the platform/)
})

test('temporary metadata failures keep an unexpired identity, back off, and report transitions only', async t => {
  const { state, broker, spec } = await environment(t)
  const child = await broker.activate(spec)
  const old = await broker.get()
  state.now += 1800_000
  state.renewalStatus = 503
  const initial = state.renewalRequests.length
  const call = async () => {
    const response = await fetch(child.mcp_servers.zwrm.url, { method: 'POST', body: '{}' })
    assert.equal(response.status, 200)
    await response.text()
  }
  await Promise.all(Array.from({ length: 8 }, call))
  assert.equal(state.renewalRequests.length, initial + 1)
  assert.ok(state.accepted.every(x => x.auth === `Bearer ${old}`))
  await call()
  assert.equal(state.renewalRequests.length, initial + 1, 'a retry burst must not hammer metadata')
  // Thirty minutes of failed renewals remain one diagnostic, not a transcript flood.
  for (let n = 0; n < 119; n++) {
    state.now += 15_000
    await broker.get().catch(() => {})
  }
  assert.equal(state.diagnostics.length, 1)
  assert.ok(state.renewalRequests.length - initial <= 62, 'retry delay must reach 30 seconds')
  await assert.rejects(broker.get(), /metadata unavailable/, 'expiry never falls back to the cached bearer')
  state.renewalStatus = 0
  state.now += 30_000
  assert.notEqual(await broker.get(), old)
  assert.equal(state.diagnostics.length, 2)
  assert.equal(state.diagnostics[1].recovered, true)
})

test('explicit revocation never falls back to an otherwise unexpired identity', async t => {
  const { state, broker, spec } = await environment(t)
  const child = await broker.activate(spec)
  state.now += 1800_000
  state.denyRenewal = true
  const response = await fetch(child.mcp_servers.zwrm.url, { method: 'POST', body: '{}' })
  assert.equal(response.status, 502)
  await response.text()
  assert.equal(state.accepted.length, 0)
})

test('a rejected bearer cannot return through the transient-error fallback', async t => {
  const { state, broker, spec } = await environment(t)
  const child = await broker.activate(spec)
  state.rejectNext = true
  state.renewalStatus = 503
  const response = await fetch(child.mcp_servers.zwrm.url, { method: 'POST', body: '{}' })
  assert.equal(response.status, 502)
  await response.text()
  await assert.rejects(broker.get(), /metadata unavailable/)
  assert.equal(state.accepted.length, 0)
})

test('CLI renews workspace-only identity even when restore leaves the guest clock frozen', async t => {
  const { state, broker, spec } = await environment(t)
  await broker.activate(spec)
  const first = await (await fetch(broker.url + '/token')).json()
  const guestClock = state.now
  state.cpNow = state.now + 25 * 3600_000
  const second = await (await fetch(broker.url + '/token')).json()
  assert.equal(state.now, guestClock)
  assert.notEqual(first.token, second.token)
  assert.equal(state.renewalRequests.at(-1), '/agent/identity/machine')
  // Without metadata there is no trustworthy indication of elapsed suspend
  // time. CLI calls fail closed instead of handing out a potentially old key.
  state.renewalStatus = 503
  assert.equal((await fetch(broker.url + '/token')).status, 502)
})

// #1664, the whole chain with the real broker and pusher. A woken VM renews
// before the wake has recorded it (404 before the machine row, 403 before the
// workspace link), and the broker serves each refusal again from its backoff.
// The pusher must retry into the recorded wake, count only the control
// plane's refusals, and take only a persisting one for revocation.
async function deliveryEnvironment(t, { parked = true } = {}) {
  // A clock that moves on every read, so the broker's renewal backoff (1 s,
  // then 2 s, … 30 s) passes while the pusher retries every few milliseconds.
  let clock = Date.now()
  const state = { refusals: [], minted: 0, renewals: 0, events: [], posts: 0, eventsStatus: 200 }
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/agent/identity/')) {
      // Session renewals only: deactivate() renews the workspace identity.
      if (req.url.endsWith('/session')) state.renewals++
      const status = state.refusals === 'forever' ? 403 : state.refusals.shift()
      if (status) { res.writeHead(status).end('agent identity refused'); return }
      state.minted++
      const issued_at = Math.floor(clock / 1000)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ token: `zwai1.test.${state.minted}`, issued_at, expires_at: issued_at + 3600 }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    state.posts++
    if (state.eventsStatus !== 200) { res.writeHead(state.eventsStatus).end('{"error":"refused"}'); return }
    state.events.push(...JSON.parse(Buffer.concat(chunks).toString()).events)
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const broker = await new CredentialBroker({ metadataURL: url, platformURL: url, machineID: 'machine', now: () => (clock += 250) }).start(0)
  // The real 15 s tick would see the fake clock's jumps as a wake and rebuild
  // the identities mid-test on a slow runner.
  clearInterval(broker.timer)
  t.after(async () => { pusher.stop(); await broker.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await broker.activate({ session_id: 'session', mcp_servers: {} })
  // Count only what the test causes: activate() renewed once.
  state.renewals = 0
  const stops = []
  const pusher = new EventPusher(url + '/v1/internal/agent-sessions/session/events', 'session', { broker, onStopped: reason => stops.push(reason), flushMs: 0, retryMs: 1, maxRetryMs: 4 })
  // Parked for an hour: the credential has lapsed, so the next push renews.
  if (parked) clock += 3600_000
  return { state, broker, pusher, stops }
}

async function until(done, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

test('a pusher retries through the renewals a wake refuses', async t => {
  const { state, pusher, stops } = await deliveryEnvironment(t)
  state.refusals = [404, 403]
  pusher.emit('session.status', { permission_mode: 'bypassPermissions' })
  pusher.emit('turn.started', { harness: 'claude' })
  await until(() => state.events.length === 2)
  assert.equal(pusher.stopped, false)
  assert.deepEqual(stops, [])
  assert.equal(state.renewals, 3, 'each refusal is one renewal, served again from backoff rather than repeated')
})

test('a refusal streak the control plane breaks starts over', async t => {
  const { state, pusher, stops } = await deliveryEnvironment(t)
  // Refused one short of the limit, a 503 (retryable, e.g. mid-wake), then
  // refused one short again: never revocation.
  const short = Array(MAX_RENEWAL_REFUSALS - 1).fill(403)
  state.refusals = [...short, 503, ...short]
  pusher.emit('sdk.assistant', { n: 1 })
  await until(() => state.events.length === 1, 30_000)
  assert.equal(pusher.stopped, false)
  assert.deepEqual(stops, [])
})

test('a pusher gives up on an identity the control plane keeps refusing', async t => {
  const { state, broker, pusher, stops } = await deliveryEnvironment(t)
  state.refusals = 'forever'
  pusher.emit('sdk.assistant', { n: 1 })
  await until(() => pusher.stopped, 30_000)
  assert.equal(state.renewals, MAX_RENEWAL_REFUSALS, 'gives up after exactly the limit of real refusals')
  assert.equal(stops.length, 1)
  assert.deepEqual(state.events, [])
  assert.equal(broker.sessionID, '', 'the revoked session identity is deactivated')
})

// The other way in: a bearer the broker still holds is refused by the callback
// (401), request() renews once with the bearer marked rejected, and that
// renewal is refused. Each attempt costs one renewal, and the refusal served
// again from backoff is not counted twice.
test('a refused bearer and a refused renewal behind it give up after the same count', async t => {
  const { state, pusher, stops } = await deliveryEnvironment(t, { parked: false })
  state.eventsStatus = 401
  state.refusals = 'forever'
  pusher.emit('sdk.assistant', { n: 1 })
  await until(() => pusher.stopped, 30_000)
  assert.equal(state.posts, 1, 'only the held bearer reaches the callback')
  assert.equal(state.renewals, MAX_RENEWAL_REFUSALS)
  assert.equal(stops.length, 1)
})
