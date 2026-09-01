// A fake `opencode serve` (#1391): the v1 HTTP surface + /event SSE the
// driver speaks, in-process (the driver attaches via ZWRM_OPENCODE_URL, so no
// child is spawned). It VALIDATES everything it receives — the codex suite's
// lesson: five tests once passed because the fake echoed the driver's own
// assumptions, so every "the driver sends X" assertion checked the driver
// against itself. A violation is recorded and fails the test via
// assertNoViolations, not swallowed.
//
// Wire shapes mirror the probed 1.18.25 binary: `permission.asked` events
// (not the docs' permission.updated), POST /session/:id/permissions/:pid
// {response}, prompt_async 204, session-cumulative cost on GET /session/:id.
import { createServer } from 'node:http'

export async function startFakeOpenCode({ password = 'test', expectProvider = 'zwrm' } = {}) {
  const state = {
    sessions: new Map(), // id -> {id, cost, tokens}
    prompts: [], // validated prompt bodies, in order
    replies: [], // {permissionID, response}
    aborts: 0,
    pendingAsks: new Set(), // permission ids the fake has asked and not seen replied
    violations: [],
    nextSession: 1,
  }
  const sseClients = new Set()

  const violate = (msg) => state.violations.push(msg)

  const readBody = (req) => new Promise((resolve) => {
    let b = ''
    req.on('data', (d) => { b += d })
    req.on('end', () => resolve(b))
  })

  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization || ''
    const expected = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
    if (auth !== expected) {
      violate(`bad auth header on ${req.method} ${req.url}`)
      res.writeHead(401).end()
      return
    }
    const url = new URL(req.url, 'http://x')
    const parts = url.pathname.split('/').filter(Boolean)

    if (req.method === 'GET' && url.pathname === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"type":"server.connected","properties":{}}\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }
    if (req.method === 'POST' && url.pathname === '/session') {
      const id = `ses_fake${state.nextSession++}`
      const sess = { id, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
      state.sessions.set(id, sess)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sess))
      return
    }
    if (parts[0] === 'session' && parts.length >= 2) {
      const sess = state.sessions.get(parts[1])
      if (!sess) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'session not found' }))
        return
      }
      if (req.method === 'GET' && parts.length === 2) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sess))
        return
      }
      if (req.method === 'POST' && parts[2] === 'prompt_async') {
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          violate('prompt_async body is not JSON')
          res.writeHead(400).end()
          return
        }
        // Validate the contract the CP and the seeded config depend on.
        if (!Array.isArray(body.parts) || body.parts.length === 0 ||
            body.parts.some((p) => p?.type !== 'text' || typeof p.text !== 'string' || p.text === '')) {
          violate(`prompt parts malformed: ${JSON.stringify(body.parts)}`)
        }
        if (body.model !== undefined) {
          if (body.model?.providerID !== expectProvider || typeof body.model?.modelID !== 'string' || !body.model.modelID) {
            violate(`prompt model malformed: ${JSON.stringify(body.model)}`)
          }
        }
        if (body.tools?.question !== false) {
          violate(`prompt must disable the question tool, got tools=${JSON.stringify(body.tools)}`)
        }
        state.prompts.push(body)
        res.writeHead(204).end()
        return
      }
      if (req.method === 'POST' && parts[2] === 'permissions' && parts.length === 4) {
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          violate('permission reply body is not JSON')
          res.writeHead(400).end()
          return
        }
        if (!['once', 'always', 'reject'].includes(body.response)) {
          violate(`permission reply response invalid: ${JSON.stringify(body)}`)
        }
        if (body.response === 'always') {
          violate('the driver must never grant "always": it would outlive the platform gate')
        }
        if (!state.pendingAsks.has(parts[3])) {
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'no pending ask' }))
          return
        }
        state.pendingAsks.delete(parts[3])
        state.replies.push({ permissionID: parts[3], response: body.response })
        res.writeHead(200, { 'content-type': 'application/json' }).end('true')
        return
      }
      if (req.method === 'POST' && parts[2] === 'abort') {
        state.aborts++
        res.writeHead(200, { 'content-type': 'application/json' }).end('true')
        return
      }
    }
    violate(`unexpected request ${req.method} ${url.pathname}`)
    res.writeHead(404).end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`

  return {
    url,
    state,
    // emit pushes one SSE event to every connected client.
    emit(type, properties) {
      if (type === 'permission.asked' && properties?.id) state.pendingAsks.add(properties.id)
      const line = `data: ${JSON.stringify({ type, properties })}\n\n`
      for (const c of sseClients) c.write(line)
    },
    setSessionCost(id, cost) {
      const sess = state.sessions.get(id)
      if (sess) sess.cost = cost
    },
    seedSession(id, cost = 0) {
      state.sessions.set(id, { id, cost, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    },
    assertNoViolations(assert) {
      assert.deepEqual(state.violations, [])
    },
    async close() {
      for (const c of sseClients) c.end()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
