// Image-declared desktop (#1680): manifest parsing, status/control, start,
// and the raw VNC relay over an HTTP Upgrade.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHTTP, request } from 'node:http'
import { createServer as createTCP } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CONTROL_LEASE_MS, desktopStatus, loadDesktop, parseControl, parseDesktopManifest, relayVNC, startDesktop, writeControl,
} from '../desktop.mjs'

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

async function withTmp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'desktop-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('parseDesktopManifest validates and normalizes', () => {
  const d = parseDesktopManifest(JSON.stringify({ start: ['/bin/true'], vnc_port: 5900, control_file: '/tmp/c', width: 1280, height: 800 }))
  assert.deepEqual(d, { start: ['/bin/true'], vncPort: 5900, controlFile: '/tmp/c', width: 1280, height: 800 })
  for (const bad of [
    { start: ['true'], vnc_port: 5900, control_file: '/tmp/c' },
    { start: [], vnc_port: 5900, control_file: '/tmp/c' },
    { start: ['/bin/true'], vnc_port: 0, control_file: '/tmp/c' },
    { start: ['/bin/true'], vnc_port: 5900, control_file: 'rel' },
  ]) assert.throws(() => parseDesktopManifest(JSON.stringify(bad)), undefined, JSON.stringify(bad))
})

test('no manifest: unavailable (agent-base ships none)', async () => {
  assert.equal(await loadDesktop('/nonexistent/desktop.json'), null)
  assert.deepEqual(await desktopStatus(null), { available: false, running: false, control: 'agent' })
})

test('status reflects the VNC port and the control file; control validates', async () => {
  await withTmp(async (dir) => {
    const vnc = createTCP((s) => s.end())
    const port = await listen(vnc)
    try {
      const file = path.join(dir, 'desktop.json')
      await writeFile(file, JSON.stringify({ start: ['/bin/true'], vnc_port: port, control_file: path.join(dir, 'ctl'), width: 1280, height: 800 }))
      const desktop = await loadDesktop(file)
      assert.deepEqual(await desktopStatus(desktop), { available: true, running: true, control: 'agent', width: 1280, height: 800 })
      assert.deepEqual(await writeControl(desktop, { holder: 'user', userId: 'u1' }), { holder: 'user', userId: 'u1' })
      assert.match((await readFile(path.join(dir, 'ctl'), 'utf8')).trim(), /^user \d+ u1$/)
      const st = await desktopStatus(desktop)
      assert.equal(st.control, 'user')
      assert.equal(st.control_user_id, 'u1')
      await assert.rejects(writeControl(desktop, { holder: 'root' }), (e) => e.status === 400)
      await assert.rejects(writeControl(desktop, { holder: 'user' }), (e) => e.status === 400, 'taking control needs a user id')
    } finally {
      vnc.close()
    }
    const down = parseDesktopManifest(JSON.stringify({ start: ['/bin/true'], vnc_port: 1, control_file: path.join(dir, 'ctl2') }))
    assert.equal((await desktopStatus(down)).running, false)
  })
})

test('startDesktop runs the command, then waits for the port; failures are reported', async () => {
  await withTmp(async (dir) => {
    const vnc = createTCP((s) => s.end())
    const port = await listen(vnc)
    try {
      await startDesktop(parseDesktopManifest(JSON.stringify({ start: ['/bin/true'], vnc_port: port, control_file: '/tmp/x' })))
      await assert.rejects(
        startDesktop(parseDesktopManifest(JSON.stringify({ start: ['/bin/sh', '-c', 'echo nope >&2; exit 3'], vnc_port: port, control_file: '/tmp/x' }))),
        /exited 3: nope/)
    } finally {
      vnc.close()
    }
  })
})

// upgrade opens `Upgrade: zwrm-vnc` against srvPort and resolves with
// {status, socket} once the response head arrives.
function upgrade(srvPort) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: srvPort, path: '/desktop/vnc', headers: { Connection: 'Upgrade', Upgrade: 'zwrm-vnc' } })
    req.on('upgrade', (res, socket, head) => resolve({ status: res.statusCode, socket, head: String(head || '') }))
    req.on('response', (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('relayVNC: 101 then raw bytes both ways; 503 when the desktop is down', async () => {
  // A fake VNC server: greets like RFB, then echoes uppercased.
  const vncSockets = new Set()
  const vnc = createTCP((s) => {
    vncSockets.add(s)
    s.on('error', () => {})
    s.write('RFB 003.008\n')
    s.on('data', (d) => s.write(String(d).toUpperCase()))
  })
  const vncPort = await listen(vnc)
  let desktop = parseDesktopManifest(JSON.stringify({ start: ['/bin/true'], vnc_port: vncPort, control_file: '/tmp/x' }))
  const http = createHTTP((_, res) => res.end())
  http.on('upgrade', (req, socket, head) => relayVNC(desktop, socket, head))
  const port = await listen(http)
  try {
    const { status, socket, head } = await upgrade(port)
    assert.equal(status, 101)
    // Bytes that arrive with the 101 (the RFB greeting) come as `head`, not
    // socket data: a relay client must forward them first.
    const got = await new Promise((resolve) => {
      let buf = head
      socket.on('data', (d) => {
        buf += d
        if (buf.includes('RFB 003.008\n') && buf.includes('HELLO')) resolve(buf)
      })
      socket.write('hello')
    })
    assert.match(got, /^RFB 003\.008\nHELLO/)
    socket.destroy()

    desktop = parseDesktopManifest(JSON.stringify({ start: ['/bin/true'], vnc_port: 1, control_file: '/tmp/x' }))
    const down = await upgrade(port)
    assert.equal(down.status, 503)
    assert.match(down.body, /desktop is not running/)
  } finally {
    http.closeAllConnections()
    http.close()
    for (const s of vncSockets) s.destroy()
    vnc.close()
  }
})

test('control is a lease: it lapses back to the agent unless renewed', () => {
  const now = 1_000_000
  assert.deepEqual(parseControl(`user ${now + 1} u1`, now), { holder: 'user', userId: 'u1' })
  assert.equal(parseControl(`user ${now} u1`, now).holder, 'agent', 'expired')
  assert.equal(parseControl('user', now).holder, 'agent', 'no expiry never locks the agent out')
  assert.equal(parseControl('agent', now).holder, 'agent')
  assert.equal(parseControl('', now).holder, 'agent')
  assert.equal(CONTROL_LEASE_MS, 90_000, 'the 90 s contract the dashboard renews against (every 30 s)')
  assert.equal(parseControl('user Infinity u1', now).holder, 'agent', 'never an unbounded lease')
  assert.equal(parseControl(`user ${now + 10 * 60_000} u1`, now).holder, 'agent', 'never beyond one lease window')
})

test('control: one person at a time; renewals never re-take; anyone hands back', async () => {
  await withTmp(async (dir) => {
    const desktop = parseDesktopManifest(JSON.stringify({ start: ['/bin/true'], vnc_port: 1, control_file: path.join(dir, 'ctl') }))
    await writeControl(desktop, { holder: 'user', userId: 'alice' })
    await assert.rejects(writeControl(desktop, { holder: 'user', userId: 'bob' }), (e) => e.status === 409)
    assert.deepEqual(await writeControl(desktop, { holder: 'user', userId: 'bob', renew: true }), { holder: 'user', userId: 'alice' },
      "bob's renewal changes nothing")
    assert.deepEqual(await writeControl(desktop, { holder: 'user', userId: 'alice', renew: true }), { holder: 'user', userId: 'alice' })
    assert.deepEqual(await writeControl(desktop, { holder: 'agent' }), { holder: 'agent', userId: '' }, 'anyone may hand back')
    assert.deepEqual(await writeControl(desktop, { holder: 'user', userId: 'alice', renew: true }), { holder: 'agent', userId: '' },
      "alice's late renewal does not re-take after the hand-back")
    assert.deepEqual(await writeControl(desktop, { holder: 'user', userId: 'bob' }), { holder: 'user', userId: 'bob' })
  })
})

test('control: concurrent takes are serialized, exactly one wins', async () => {
  await withTmp(async (dir) => {
    const desktop = parseDesktopManifest(JSON.stringify({ start: ['/bin/true'], vnc_port: 1, control_file: path.join(dir, 'ctl') }))
    const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map((u) => writeControl(desktop, { holder: 'user', userId: u })))
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 3)
  })
})
