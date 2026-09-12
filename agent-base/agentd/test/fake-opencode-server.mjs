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
// {response}, prompt_async 204, session-cumulative cost on GET /session/:id,
// and the question service (#1555): `question.asked` events answered by POST
// /question/:qid/reply {answers: string[][]} or POST /question/:qid/reject
// (packages/opencode/src/server/routes/instance/httpapi/groups/question.ts
// at the pinned tag).
import { createServer } from 'node:http'

export async function startFakeOpenCode({ password = 'test', expectProvider = 'zwrm', commands, eventDelayMS = 0 } = {}) {
  const state = {
    sessions: new Map(), // id -> {id, cost, tokens}
    prompts: [], // validated prompt bodies, in order
    commandInvocations: [], // validated POST /session/:id/command bodies
    replies: [], // {permissionID, response}
    aborts: 0,
    pendingAsks: new Set(), // permission ids the fake has asked and not seen replied
    pendingQuestions: new Set(), // question ids the fake has asked and not seen answered
    questionReplies: [], // {questionID, answers} | {questionID, rejected: true}
    violations: [],
    nextSession: 1,
    // GET /command serves the probed raw shape: name/description/hints
    // (string array)/template — plus source, which normalization drops.
    commands: commands ?? [
      { name: 'greet', description: 'Greets someone warmly', source: 'command', template: 'Say hi to $ARGUMENTS.', hints: ['$ARGUMENTS'] },
      { name: 'noargs', description: 'No arguments', source: 'command', template: 'State the status.', hints: [] },
    ],
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
      const attach = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"type":"server.connected","properties":{}}\n\n')
        if (state.subscribedAt === undefined) state.subscribedAt = Date.now()
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
      }
      if (eventDelayMS > 0) setTimeout(attach, eventDelayMS)
      else attach()
      return
    }
    if (req.method === 'GET' && url.pathname === '/command') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state.commands))
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
        state.prompts.push(body)
        if (state.firstPromptAt === undefined) state.firstPromptAt = Date.now()
        res.writeHead(204).end()
        return
      }
      if (req.method === 'POST' && parts[2] === 'command' && parts.length === 3) {
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          violate('command body is not JSON')
          res.writeHead(400).end()
          return
        }
        // The real endpoint 500s on an unknown name (probed) — the driver
        // must pre-resolve, so reaching the fake with one is a violation.
        if (!state.commands.some((c) => c.name === body.command)) {
          violate(`command invoked with unknown name: ${JSON.stringify(body.command)}`)
          res.writeHead(500).end(JSON.stringify({ name: 'UnknownError' }))
          return
        }
        if (body.arguments !== undefined && typeof body.arguments !== 'string') {
          violate(`command arguments must be a string: ${JSON.stringify(body.arguments)}`)
        }
        // Unlike prompt_async's {providerID, modelID} object, the command
        // body's model is the "provider/model" STRING (probed).
        if (body.model !== undefined &&
            (typeof body.model !== 'string' || !body.model.startsWith(`${expectProvider}/`) || body.model.length <= expectProvider.length + 1)) {
          violate(`command model malformed: ${JSON.stringify(body.model)}`)
        }
        state.commandInvocations.push(body)
        // The real endpoint is synchronous until the turn ends; the fake
        // answers immediately because tests drive the turn over SSE and the
        // driver never awaits this response.
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ info: {}, parts: [] }))
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
    if (req.method === 'POST' && parts[0] === 'question' && parts.length === 3) {
      const questionID = parts[1]
      if (!state.pendingQuestions.has(questionID)) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'QuestionNotFoundError', data: { requestID: questionID } }))
        return
      }
      if (parts[2] === 'reject') {
        state.pendingQuestions.delete(questionID)
        state.questionReplies.push({ questionID, rejected: true })
        res.writeHead(200, { 'content-type': 'application/json' }).end('true')
        return
      }
      if (parts[2] === 'reply') {
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          violate('question reply body is not JSON')
          res.writeHead(400).end()
          return
        }
        // The schema: answers is an array with one string array per
        // question, in question order. Anything else is a 400 on the real
        // server (Effect schema decode), so it is a violation here.
        const ok = Array.isArray(body?.answers) &&
          body.answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'))
        if (!ok) {
          violate(`question reply answers malformed: ${JSON.stringify(body)}`)
          res.writeHead(400).end()
          return
        }
        state.pendingQuestions.delete(questionID)
        state.questionReplies.push({ questionID, answers: body.answers })
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
      if (type === 'question.asked' && properties?.id) state.pendingQuestions.add(properties.id)
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
