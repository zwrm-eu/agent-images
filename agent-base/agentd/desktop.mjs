// Image-declared desktop (#1680): the live view a member watches (and can
// take over) in the dashboard. An agent image that has a virtual desktop
// declares it in DESKTOP_MANIFEST; agent-base declares none, so nothing here
// is reachable for agents without one.
//
//   { "start": ["/usr/local/bin/node", "/opt/x/desktop.mjs", "start"],
//     "vnc_port": 5900,                      // VNC server on 127.0.0.1
//     "control_file": "/tmp/.zwrm-desktop-control",
//     "width": 1280, "height": 800 }
//
// The daemon never speaks VNC. It relays one raw TCP stream from the control
// plane to 127.0.0.1:<vnc_port> (an HTTP Upgrade on the token-gated daemon
// port, so the VNC server itself listens on loopback only and needs no
// password), runs the image's start command on request, and records who
// holds input: the control file says "user <expiry-ms> <user-id>" while a member has
// taken over, and the image's computer-use tools refuse input actions until
// that expiry. Control is a LEASE the dashboard renews while the member holds
// it: a closed tab or a crashed browser must not lock the agent out for good,
// so an unrenewed lease simply lapses back to the agent.

import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'

export const DESKTOP_MANIFEST = '/etc/zwrm/desktop.json'
const START_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 1_000
export const CONTROL_LEASE_MS = 90_000
const LEASE_SLACK_MS = 5_000

// loadDesktop returns the parsed manifest, or null when the image declares no
// desktop (the normal case) or the manifest is unusable (logged).
export async function loadDesktop(file = DESKTOP_MANIFEST, log = () => {}) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') log(`desktop: cannot read ${file}: ${err?.message || err}`)
    return null
  }
  try {
    return parseDesktopManifest(text)
  } catch (err) {
    log(`desktop: ignoring ${file}: ${err?.message || err}`)
    return null
  }
}

// parseDesktopManifest validates a manifest. Exported for tests.
export function parseDesktopManifest(text) {
  const m = JSON.parse(text)
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('manifest must be a JSON object')
  if (!Array.isArray(m.start) || m.start.length === 0 || !m.start.every((a) => typeof a === 'string') ||
      !path.isAbsolute(m.start[0])) {
    throw new Error('start must be an argv array whose first element is an absolute path')
  }
  if (!Number.isInteger(m.vnc_port) || m.vnc_port < 1 || m.vnc_port > 65535) throw new Error('vnc_port must be a TCP port')
  if (typeof m.control_file !== 'string' || !path.isAbsolute(m.control_file)) {
    throw new Error('control_file must be an absolute path')
  }
  const dim = (v) => (Number.isInteger(v) && v > 0 ? v : null)
  return { start: m.start, vncPort: m.vnc_port, controlFile: m.control_file, width: dim(m.width), height: dim(m.height) }
}

// vncListening probes the VNC port: the desktop counts as running when its
// VNC server accepts a connection.
export function vncListening(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    const done = (ok) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

// parseControl reads a control file's content: "user <expiry-ms> <user-id>"
// is a live member lease until then; anything else (missing, "agent",
// expired, malformed) means the agent holds input. Returns {holder, userId}.
// Exported for tests; the image's computer-use server applies the same
// holder rule (it reads only the first two fields).
// A lease is honoured only within one lease window of now: a malformed or
// hand-edited file ("user Infinity", a far-future expiry) must not lock the
// agent out beyond the 90 s contract.
export function parseControl(text, now = Date.now()) {
  const [holder, expiry, userId = ''] = String(text || '').trim().split(/\s+/)
  const until = Number(expiry)
  const live = Number.isFinite(until) && until > now && until <= now + CONTROL_LEASE_MS + LEASE_SLACK_MS
  return holder === 'user' && live ? { holder: 'user', userId } : { holder: 'agent', userId: '' }
}

export async function readControl(desktop) {
  try {
    return parseControl(await readFile(desktop.controlFile, 'utf8'))
  } catch {
    return { holder: 'agent', userId: '' }
  }
}

const conflict = (message) => Object.assign(new Error(message), { status: 409 })

// writeControl changes who holds input. holder 'user' takes the lease for
// userId (refused while ANOTHER user's lease is live: two people must not
// drive one desktop); with renew it only extends userId's own live lease and
// otherwise changes nothing, so a renewal can never take control back from
// whoever took it or from the agent after a hand-back. holder 'agent' hands
// back, whoever asks. Returns the resulting {holder, userId}.
// Serialized: the read-check-write must not interleave, or two members
// taking control at once could both be told they hold it.
let controlQueue = Promise.resolve()
export function writeControl(desktop, change = {}, now) {
  const p = controlQueue.then(() => writeControlNow(desktop, change, now ?? Date.now()))
  controlQueue = p.catch(() => {})
  return p
}

async function writeControlNow(desktop, { holder, userId = '', renew = false } = {}, now) {
  if (holder !== 'user' && holder !== 'agent') {
    const e = new Error("holder must be 'user' or 'agent'")
    e.status = 400
    throw e
  }
  if (holder === 'user' && !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    const e = new Error('user_id is required to take control')
    e.status = 400
    throw e
  }
  const current = await readControl(desktop)
  if (holder === 'user') {
    if (renew && (current.holder !== 'user' || current.userId !== userId)) return current
    if (!renew && current.holder === 'user' && current.userId !== userId) {
      throw conflict('another person has control of the desktop')
    }
    await writeFile(desktop.controlFile, `user ${now + CONTROL_LEASE_MS} ${userId}\n`)
    return { holder: 'user', userId }
  }
  await writeFile(desktop.controlFile, 'agent\n')
  return { holder: 'agent', userId: '' }
}

export async function desktopStatus(desktop) {
  if (!desktop) return { available: false, running: false, control: 'agent' }
  const control = await readControl(desktop)
  return {
    available: true,
    running: await vncListening(desktop.vncPort),
    control: control.holder,
    ...(control.userId ? { control_user_id: control.userId } : {}),
    ...(desktop.width ? { width: desktop.width } : {}),
    ...(desktop.height ? { height: desktop.height } : {}),
  }
}

// startDesktop runs the image's start command (idempotent on the image's
// side) and waits for it to exit, then for the VNC port.
export async function startDesktop(desktop, log = () => {}) {
  const [cmd, ...args] = desktop.start
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('desktop start timed out')) }, START_TIMEOUT_MS)
    child.once('error', (err) => { clearTimeout(timer); reject(err) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`desktop start exited ${code}: ${stderr.trim()}`))
    })
  })
  const deadline = Date.now() + 5_000
  while (!(await vncListening(desktop.vncPort))) {
    if (Date.now() > deadline) throw new Error('desktop started but its VNC server is not listening')
    await new Promise((r) => setTimeout(r, 200))
  }
  log('desktop: started')
}

// relayVNC answers an authenticated `Upgrade: zwrm-vnc` request on the
// daemon socket: 101, then raw bytes both ways with 127.0.0.1:<vnc_port>.
// The control plane bridges that stream to the member's WebSocket.
export function relayVNC(desktop, socket, head, log = () => {}) {
  const upstream = connect({ host: '127.0.0.1', port: desktop.vncPort })
  let opened = false
  upstream.once('connect', () => {
    opened = true
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: zwrm-vnc\r\nConnection: Upgrade\r\n\r\n')
    if (head?.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.once('error', (err) => {
    if (!opened) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' +
        JSON.stringify({ error: 'desktop is not running' }))
      return
    }
    log(`desktop: vnc relay error: ${err?.message || err}`)
    socket.destroy()
  })
  const close = () => { upstream.destroy(); socket.destroy() }
  upstream.once('close', close)
  socket.once('close', close)
  socket.once('error', close)
}
