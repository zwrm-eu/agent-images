// OpenCode server client (#1391): spawns `opencode serve` as a per-session
// child and speaks its v1 HTTP surface plus the /event SSE stream. Split from
// the driver so the HTTP/SSE mechanics are unit-testable against a fake
// server (ZWRM_OPENCODE_URL attach mode) without a binary on PATH.
//
// Why a child per session rather than one shared server: the daemon hosts one
// session at a time by design, the child's lifetime then equals the session's
// (no cross-session state to reason about), and a wedged server is killed
// with its session instead of poisoning the next one. The binary is
// Bun-compiled and cold-starts in well under a second.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const START_TIMEOUT_MS = 30_000
// One SSE drop is survivable (the server buffers nothing, but our state
// machine re-reads terminal state via GET /session). Ten consecutive failures
// with the child still alive means something is genuinely wrong.
const MAX_SSE_FAILURES = 10

export class OpenCodeHTTPError extends Error {
  constructor(status, body, path) {
    super(`opencode ${path} failed: HTTP ${status}${body ? ` ${body.slice(0, 300)}` : ''}`)
    this.status = status
    this.body = body
  }
}

export class OpenCodeServer {
  // opts: {bin, cwd, env, log, onEvent, onExit}
  // - attach mode: when env.ZWRM_OPENCODE_URL is set (tests), no child is
  //   spawned and close() kills nothing.
  constructor(opts) {
    this.opts = opts
    this.child = null
    this.baseURL = ''
    this.password = randomBytes(16).toString('hex')
    this.closed = false
    this.sseAbort = null
  }

  async start() {
    const attach = this.opts.env?.ZWRM_OPENCODE_URL || process.env.ZWRM_OPENCODE_URL
    if (attach) {
      this.baseURL = attach.replace(/\/$/, '')
      this.password = this.opts.env?.OPENCODE_SERVER_PASSWORD || 'test'
      return
    }
    // --port 0 lets the kernel pick a free port; the listen line names it.
    // The password locks the server to this daemon: without it, any process
    // in the VM (i.e. the model, via bash) could drive the session API —
    // including answering its own permission asks.
    const child = spawn(this.opts.bin, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: this.opts.cwd,
      env: { ...this.opts.env, OPENCODE_SERVER_PASSWORD: this.password },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let stderrTail = ''
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000)
    })
    child.on('exit', (code, signal) => {
      if (this.closed) return
      this.closed = true
      this.sseAbort?.abort()
      this.opts.onExit?.(new Error(`opencode serve exited (code ${code}, signal ${signal}): ${stderrTail.trim().slice(-300)}`))
    })

    this.baseURL = await new Promise((resolve, reject) => {
      let out = ''
      const timer = setTimeout(() => {
        reject(new Error(`opencode serve did not report a listen address within ${START_TIMEOUT_MS / 1000}s: ${stderrTail.trim().slice(-300)}`))
      }, START_TIMEOUT_MS)
      child.stdout.on('data', (d) => {
        out += d.toString()
        const m = out.match(/listening on (http:\/\/[^\s]+)/)
        if (m) {
          clearTimeout(timer)
          resolve(m[1].replace(/\/$/, ''))
        }
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error(`opencode serve exited before listening: ${stderrTail.trim().slice(-300)}`))
      })
    })
  }

  authHeader() {
    return 'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64')
  }

  // request performs one JSON round-trip. Turn-carrying calls pass no timeout
  // (a turn legitimately takes minutes); teardown calls pass one so a wedged
  // server cannot hang /interrupt or shutdown (the codex rule).
  async request(method, path, body, { timeoutMS } = {}) {
    const ctrl = timeoutMS ? AbortSignal.timeout(timeoutMS) : undefined
    const res = await fetch(this.baseURL + path, {
      method,
      headers: {
        authorization: this.authHeader(),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(ctrl ? { signal: ctrl } : {}),
    })
    const text = await res.text()
    if (!res.ok) throw new OpenCodeHTTPError(res.status, text, path)
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  // startEvents subscribes to /event and dispatches each parsed event to
  // onEvent. Reconnects on stream drop — a dead event stream mid-turn would
  // otherwise wedge the session silently — and reports through onExit only
  // after MAX_SSE_FAILURES consecutive failures.
  startEvents() {
    void this.eventLoop()
  }

  async eventLoop() {
    let failures = 0
    while (!this.closed) {
      this.sseAbort = new AbortController()
      try {
        const res = await fetch(this.baseURL + '/event', {
          headers: { authorization: this.authHeader(), accept: 'text/event-stream' },
          signal: this.sseAbort.signal,
        })
        if (!res.ok || !res.body) throw new OpenCodeHTTPError(res.status, '', '/event')
        // failures resets only once a stream DELIVERS something: a server
        // that accepts and immediately EOFs would otherwise reset the
        // counter every lap and reconnect forever without ever reporting
        // (review) — a wedged session with no error on any surface.
        let delivered = false
        let buf = ''
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString('utf8')
          let at
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, at)
            buf = buf.slice(at + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue
              let ev
              try {
                ev = JSON.parse(line.slice(6))
              } catch {
                continue
              }
              if (!delivered) {
                delivered = true
                failures = 0
              }
              try {
                this.opts.onEvent?.(ev)
              } catch (err) {
                this.opts.log?.(`opencode event handler failed: ${err?.stack || err}`)
              }
            }
          }
        }
        // Clean end of stream: the server closed it (shutdown or restart);
        // fall through to reconnect unless we are closing. An empty stream
        // still counts against the failure budget (see `delivered`).
        if (!delivered && !this.closed) {
          failures++
          if (failures >= MAX_SSE_FAILURES) {
            this.closed = true
            this.opts.onExit?.(new Error(`opencode event stream closed empty ${failures} times`))
            return
          }
        }
      } catch (err) {
        if (this.closed) return
        failures++
        this.opts.log?.(`opencode event stream dropped (${failures}/${MAX_SSE_FAILURES}): ${err?.message || err}`)
        if (failures >= MAX_SSE_FAILURES) {
          this.closed = true
          this.opts.onExit?.(new Error(`opencode event stream failed ${failures} times: ${err?.message || err}`))
          return
        }
      }
      if (!this.closed) await delay(Math.min(500 * (failures + 1), 3000))
    }
  }

  close() {
    if (this.closed && !this.child) return
    this.closed = true
    this.sseAbort?.abort()
    if (this.child) {
      try {
        this.child.kill('SIGTERM')
      } catch { /* already gone */ }
      const c = this.child
      // A server that ignores SIGTERM must not outlive its VM slot.
      setTimeout(() => {
        try { c.kill('SIGKILL') } catch { /* already gone */ }
      }, 5000).unref()
      this.child = null
    }
  }
}
