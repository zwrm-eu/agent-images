// Image-declared MCP servers (#1676): manifest validation, directory loading,
// and the merge rules into a session spec.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadImageMCPServers, parseManifest, withImageServers } from '../image-mcp.mjs'

test('parseManifest renders the claude SDK stdio shape', () => {
  assert.deepEqual(
    parseManifest('browser', JSON.stringify({ command: '/usr/bin/pw', args: ['--headless'], env: { DISPLAY: ':99' } })),
    { server: { type: 'stdio', command: '/usr/bin/pw', args: ['--headless'], env: { DISPLAY: ':99' } }, escalate: false },
  )
  assert.deepEqual(parseManifest('x', '{"command":"/bin/x","escalate":true}'),
    { server: { type: 'stdio', command: '/bin/x' }, escalate: true })
})

test('parseManifest rejects bad names, reserved slugs and malformed fields', () => {
  const ok = '{"command":"/bin/x"}'
  for (const slug of ['Browser', 'has_underscore', '-lead', 'trail-', '']) {
    assert.throws(() => parseManifest(slug, ok), /invalid server name/, slug)
  }
  for (const slug of ['zwrm', 'platform']) assert.throws(() => parseManifest(slug, ok), /reserved/)
  assert.throws(() => parseManifest('x', '{"command":"npx"}'), /absolute path/)
  assert.throws(() => parseManifest('x', '[]'), /JSON object/)
  assert.throws(() => parseManifest('x', '{"command":"/bin/x","args":"--a"}'), /args/)
  assert.throws(() => parseManifest('x', '{"command":"/bin/x","env":{"A":1}}'), /env/)
  assert.throws(() => parseManifest('x', '{"command":"/bin/x","escalate":"yes"}'), /escalate/)
  assert.throws(() => parseManifest('x', '{not json'))
})

test('loadImageMCPServers: missing dir is empty, bad manifests are skipped', async () => {
  assert.deepEqual(await loadImageMCPServers('/nonexistent/zwrm-mcp.d'), { servers: {}, escalate: [] })

  const dir = await mkdtemp(path.join(tmpdir(), 'image-mcp-'))
  try {
    await writeFile(path.join(dir, 'browser.json'), '{"command":"/opt/pw/bin/mcp"}')
    await writeFile(path.join(dir, 'computer.json'), '{"command":"/opt/cu/bin/mcp","escalate":true}')
    await writeFile(path.join(dir, 'zwrm.json'), '{"command":"/bin/x"}')
    await writeFile(path.join(dir, 'broken.json'), '{')
    await writeFile(path.join(dir, 'README.md'), 'ignored')
    const logs = []
    const got = await loadImageMCPServers(dir, (m) => logs.push(m))
    assert.deepEqual(Object.keys(got.servers), ['browser', 'computer'])
    assert.deepEqual(got.escalate, ['computer'])
    assert.equal(logs.length, 2, 'reserved + unparsable manifests are logged')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const image = {
  servers: {
    browser: { type: 'stdio', command: '/b' },
    computer: { type: 'stdio', command: '/c' },
  },
  escalate: ['browser', 'computer'],
}

test('withImageServers merges after the CP set; a connector wins a collision', () => {
  const spec = {
    session_id: 's',
    mcp_servers: { zwrm: { type: 'http', url: 'http://p/zwrm' }, computer: { type: 'http', url: 'http://p/c' } },
    escalate_servers: ['github'],
  }
  const logs = []
  const out = withImageServers(spec, image, (m) => logs.push(m))
  assert.deepEqual(Object.keys(out.mcp_servers), ['zwrm', 'computer', 'browser'])
  assert.equal(out.mcp_servers.computer.type, 'http', 'the connector keeps its slug')
  assert.deepEqual(out.escalate_servers, ['github', 'browser'], 'only mounted image slugs escalate')
  assert.match(logs[0], /shadowed/)
  assert.equal(spec.mcp_servers.browser, undefined, 'the input spec is not mutated')
  // Drivers skip escalate_servers under bypass: an escalating image server
  // turns a bypass run into auto_approve + default, like the CP does.
  assert.equal(out.auto_approve, true)
  assert.equal(out.permission_mode, 'default')
})

test('withImageServers: escalation leaves interactive and non-bypass sessions\' modes alone', () => {
  const interactive = withImageServers({ session_id: 's', interactive: true, mcp_servers: {} }, image)
  assert.deepEqual(interactive.escalate_servers, ['browser', 'computer'])
  assert.equal(interactive.auto_approve, undefined)
  assert.equal(interactive.permission_mode, undefined)
  const gated = withImageServers({ session_id: 's', permission_mode: 'default', mcp_servers: {} }, image)
  assert.equal(gated.auto_approve, undefined)
  assert.equal(gated.permission_mode, 'default')
  const quiet = withImageServers({ session_id: 's', mcp_servers: {} }, { ...image, escalate: [] })
  assert.equal(quiet.permission_mode, undefined, 'no escalating server, no mode change')
})

test('withImageServers: no servers or a tool_policy session leaves the spec alone', () => {
  const spec = { session_id: 's', mcp_servers: {} }
  assert.equal(withImageServers(spec, { servers: {}, escalate: [] }), spec)
  const policied = { session_id: 's', tool_policy: 'platform', mcp_servers: {} }
  assert.equal(withImageServers(policied, image), policied)
})
