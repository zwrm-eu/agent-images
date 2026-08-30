// Bridge tests (#1065): the pure translators plus a live round-trip against
// an in-process MCP server over the SDK's InMemoryTransport — no HTTP, no
// API keys. The round-trip pins the contract the platform relies on: tool
// naming (mcp__<slug>__<tool>, the escalation-matching convention), JSON
// Schema pass-through, text/error result mapping.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { z } from 'zod'
import { mapMCPResult, toolDefinitionFor } from '../drivers/mcp-bridge.mjs'

test('mapMCPResult maps text content and empty results', () => {
  const r = mapMCPResult({ content: [{ type: 'text', text: 'hello' }] })
  assert.deepEqual(r, { content: [{ type: 'text', text: 'hello' }], details: null })
  assert.deepEqual(mapMCPResult({ content: [] }).content, [{ type: 'text', text: '' }])
})

test('mapMCPResult throws on isError so pi renders a tool error', () => {
  assert.throws(
    () => mapMCPResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
    /boom/,
  )
})

test('toolDefinitionFor uses the escalation naming convention and passes schema through', () => {
  const def = toolDefinitionFor('github', {
    name: 'create_issue',
    description: 'Create an issue',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  }, async () => ({ content: [] }))
  assert.equal(def.name, 'mcp__github__create_issue')
  assert.equal(def.parameters.properties.title.type, 'string')
  assert.ok(def.description.includes('Create an issue'))
})

test('bridged tool round-trips through a real MCP client/server pair', async () => {
  const server = new McpServer({ name: 'test-upstream', version: '1.0' })
  server.tool('echo', 'Echo the input', { text: z.string() }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo: ${text}` }],
  }))
  server.tool('explode', 'Always errors', {}, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'kaboom' }],
  }))

  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'bridge-test', version: '1.0' })
  await client.connect(clientT)

  const listed = await client.listTools()
  const call = (name, args) => client.callTool({ name, arguments: args || {} })
  const defs = listed.tools.map((t) => toolDefinitionFor('up', t, call))
  const echo = defs.find((d) => d.name === 'mcp__up__echo')
  const explode = defs.find((d) => d.name === 'mcp__up__explode')
  assert.ok(echo && explode, 'both tools bridged')

  const res = await echo.execute('tc1', { text: 'hi' })
  assert.deepEqual(res.content, [{ type: 'text', text: 'echo: hi' }])

  await assert.rejects(() => explode.execute('tc2', {}), /kaboom/)

  await client.close()
})

// ---- HTTP-level contract tests (#1072 review): the platform depends on the
// bearer riding EVERY request and on a stateless JSON server (405 on GET)
// being tolerated — pin both against a real HTTP server.

import { createServer } from 'node:http'
import { buildBridgedTools, isConnectionError } from '../drivers/mcp-bridge.mjs'

function statelessMCPServer(requests) {
  return createServer((req, res) => {
    requests.push({ method: req.method, auth: req.headers.authorization || '' })
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      return res.end()
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const msg = JSON.parse(body)
      if (msg.id === undefined) {
        res.writeHead(202)
        return res.end()
      }
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } }
          : msg.method === 'tools/list'
            ? { tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }] }
            : { content: [{ type: 'text', text: 'pong' }] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    })
  })
}

test('bearer rides every request; dead servers degrade; abort rejects fast', async () => {
  const requests = []
  const srv = statelessMCPServer(requests)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/mcp`
  const logs = []

  const bridge = await buildBridgedTools({
    dead: { type: 'http', url: 'http://127.0.0.1:9/nope' },
    skipme: { type: 'stdio', command: 'x' },
    svc: { type: 'http', url, headers: { Authorization: 'Bearer sekrit' } },
  }, (m) => logs.push(m))

  try {
    // Only the live server's tool bridged; the dead one degraded loudly.
    assert.deepEqual(bridge.tools.map((t) => t.name), ['mcp__svc__ping'])
    assert.ok(logs.some((l) => l.includes('dead') && l.includes('skipping')), `logs: ${logs}`)

    const res = await bridge.tools[0].execute('tc', {})
    assert.deepEqual(res.content, [{ type: 'text', text: 'pong' }])

    // The security-load-bearing contract: EVERY request to the platform
    // carried the bearer (POST initialize/list/call and any GET probe).
    assert.ok(requests.length >= 3, `requests: ${requests.length}`)
    for (const r of requests) {
      assert.equal(r.auth, 'Bearer sekrit', `missing bearer on ${r.method}`)
    }

    // A pre-aborted signal rejects without touching the upstream again.
    const before = requests.length
    await assert.rejects(() => bridge.tools[0].execute('tc2', {}, AbortSignal.abort()))
    assert.equal(requests.length, before, 'aborted call must not reach the server')
  } finally {
    bridge.close()
    srv.close()
  }
})

test('mutating cfg.headers rotates the bearer on a LIVE bridge (#1363)', async () => {
  // The gateway-token refresh endpoint swaps the platform credential by
  // mutating the spec's header objects in place; the bridge must hold them
  // by reference (no defensive copy in connectServer) or every bridged tool
  // stays pinned to the expired create-time token. This pins that contract
  // at the HTTP level: same client, no reconnect, new bearer on the wire.
  const requests = []
  const srv = statelessMCPServer(requests)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/mcp`
  const cfg = { type: 'http', url, headers: { Authorization: 'Bearer stale' } }

  const bridge = await buildBridgedTools({ svc: cfg }, () => {})
  try {
    await bridge.tools[0].execute('tc1', {})
    assert.ok(requests.every((r) => r.auth === 'Bearer stale'))

    cfg.headers.Authorization = 'Bearer fresh'
    const before = requests.length
    await bridge.tools[0].execute('tc2', {})
    const after = requests.slice(before)
    assert.ok(after.length > 0, 'second call reached the server')
    for (const r of after) {
      assert.equal(r.auth, 'Bearer fresh', `stale bearer survived on ${r.method}`)
    }
  } finally {
    bridge.close()
    srv.close()
  }
})

test('isConnectionError gates the retry: transport death yes, timeout/server errors no', () => {
  assert.ok(isConnectionError(new Error('fetch failed')))
  assert.ok(isConnectionError(new Error('socket hang up')))
  assert.ok(isConnectionError({ code: -32000, message: 'Connection closed' }))
  assert.ok(!isConnectionError({ code: -32001, message: 'Request timed out' }))
  assert.ok(!isConnectionError(new Error('MCP error -32602: invalid params')))
  assert.ok(!isConnectionError(new Error('upstream exploded')))
})
