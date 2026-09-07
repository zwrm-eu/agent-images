// JSON-RPC client for `codex app-server` (#1088).
//
// The app-server speaks NEWLINE-DELIMITED JSON over stdio — one JSON object
// per line, verified by handshake against codex-cli 0.111.0 AND the pinned
// 0.153.4. It is NOT the Content-Length framing LSP uses, and its responses
// omit the `jsonrpc` field entirely, so nothing here may require it.
//
// Three message shapes share the stream, disambiguated by which fields are
// present (direction is unambiguous because only inbound messages carry
// `method`, so the two id spaces can overlap harmlessly):
//
//   {id, method, params}   server -> client REQUEST  (approvals, dynamic tool
//                          calls) — MUST be answered or the turn stalls
//   {method, params}       server -> client NOTIFICATION (no id)
//   {id, result} / {id, error}   response to a client request
//
// Why a hand-rolled client and not @openai/codex-sdk: the SDK spawns
// `codex exec` once per turn and exposes no approval channel, no interrupt,
// and no custom tools — it cannot satisfy the platform's permission gate,
// escalation, or park-tool contracts. See plans/1088-codex-harness.md.

import { spawn } from 'node:child_process'
import readline from 'node:readline'

// CodexRPCError carries the app-server's structured error through to the
// driver's classifier (the `code`/`data` fields hold CodexErrorInfo shapes).
export class CodexRPCError extends Error {
  constructor(message, code, data) {
    super(message)
    this.name = 'CodexRPCError'
    this.code = code
    this.data = data
  }
}

export class CodexRPC {
  // onNotification(method, params) and onRequest(method, params, id) -> result
  // are supplied by the driver. onRequest MAY block indefinitely (that is how
  // a human approval works) and receives the request id so the driver can
  // correlate a `serverRequest/resolved` withdrawal; onExit fires once when
  // the child is gone.
  constructor({ command = 'codex', args = ['app-server'], env, cwd, log, onNotification, onRequest, onExit }) {
    this.log = log || (() => {})
    this.onNotification = onNotification || (() => {})
    this.onRequest = onRequest || (() => { throw new Error('unhandled server request') })
    this.onExit = onExit || (() => {})
    this.nextId = 1
    this.pending = new Map() // id -> {resolve, reject}
    this.exited = null // {code, signal} once the child is gone

    this.child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })

    // A spawn failure surfaces asynchronously on 'error', never as a throw
    // from spawn() — treat it exactly like an exit so pending callers unblock.
    this.child.once('error', (err) => this.#handleExit(null, null, err))
    this.child.once('exit', (code, signal) => this.#handleExit(code, signal, null))

    this.stderrTail = []
    this.child.stderr?.on('data', (d) => {
      const text = String(d).trimEnd()
      if (!text) return
      // Keep a bounded tail: a spawn/auth failure's only diagnosis is here,
      // and it must ride the session.error detail rather than only the log.
      this.stderrTail.push(text)
      if (this.stderrTail.length > 20) this.stderrTail.shift()
      this.log(`[codex app-server] ${text}`)
    })

    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.rl.on('line', (line) => this.#handleLine(line))
  }

  #handleExit(code, signal, err) {
    if (this.exited) return
    this.exited = { code, signal, err }
    const detail = err
      ? String(err.message || err)
      : `codex app-server exited (${signal ? `signal ${signal}` : `code ${code}`})`
    const tail = this.stderrTail.join('\n')
    const e = new CodexRPCError(tail ? `${detail}: ${tail}` : detail, 'processExit', { code, signal })
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      p.reject(e)
    }
    try { this.rl?.close() } catch { /* already closing */ }
    this.onExit(e)
  }

  #handleLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      // The app-server occasionally prints non-protocol chatter; dropping it
      // is right, crashing the session on it is not.
      this.log(`codex app-server: non-JSON stdout line: ${trimmed.slice(0, 200)}`)
      return
    }
    if (typeof msg !== 'object' || msg === null) return

    if (typeof msg.method === 'string') {
      if (msg.id === undefined || msg.id === null) {
        try {
          this.onNotification(msg.method, msg.params)
        } catch (err) {
          this.log(`codex notification handler failed (${msg.method}): ${err?.stack || err}`)
        }
        return
      }
      this.#serveRequest(msg)
      return
    }

    if (msg.id === undefined || msg.id === null) return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) {
      const { message, code, data } = msg.error
      p.reject(new CodexRPCError(String(message || 'codex app-server error'), code, data))
    } else {
      p.resolve(msg.result)
    }
  }

  // Server requests are answered asynchronously; a rejected handler still
  // sends a reply, because an unanswered request leaves the turn wedged.
  async #serveRequest(msg) {
    let result
    try {
      result = await this.onRequest(msg.method, msg.params, msg.id)
    } catch (err) {
      this.log(`codex server request failed (${msg.method}): ${err?.stack || err}`)
      this.#write({ id: msg.id, error: { code: -32603, message: String(err?.message || err) } })
      return
    }
    this.#write({ id: msg.id, result: result ?? {} })
  }

  // Returns false ONLY when the bytes will not arrive. A `false` from
  // stream.write() is backpressure, not failure: the chunk is buffered and
  // flushed as the pipe drains, so it must NOT be reported as an error.
  //
  // This matters on the common path, not an exotic one. Measured against a
  // child that is not currently reading — which is exactly an app-server busy
  // on a turn — a single 200KB write returns false, and consecutive 20KB
  // writes start returning false once the 64KB pipe buffer fills. A
  // thread/start carrying agent instructions plus the memory block, or a
  // turn/start carrying a large prompt (bodies run to MAX_BODY_BYTES = 1MB),
  // reaches those sizes routinely. Treating that as a write failure failed the
  // session with "the codex app-server exited unexpectedly" while the
  // app-server was healthy and had already begun the turn.
  #write(obj) {
    if (this.exited || !this.child.stdin?.writable) return false
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n')
      return true
    } catch (err) {
      this.log(`codex app-server write failed: ${err?.message || err}`)
      return false
    }
  }

  // timeoutMS bounds calls made on a teardown path: a live-but-wedged
  // app-server would otherwise hang /interrupt forever, and hang SIGTERM
  // shutdown past the daemon's own deadline into a SIGKILL with dirty pages.
  // Turn-carrying calls pass no timeout — a turn legitimately takes minutes.
  request(method, params, { timeoutMS } = {}) {
    if (this.exited) {
      return Promise.reject(new CodexRPCError('codex app-server is not running', 'processExit'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let timer = null
      const settle = (fn) => (v) => {
        if (timer) clearTimeout(timer)
        fn(v)
      }
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
      if (!this.#write({ jsonrpc: '2.0', id, method, params: params ?? {} })) {
        this.pending.delete(id)
        reject(new CodexRPCError('failed to write to codex app-server', 'processExit'))
        return
      }
      if (timeoutMS) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new CodexRPCError(`codex app-server did not answer ${method} within ${timeoutMS}ms`, 'timeout'))
          }
        }, timeoutMS)
        timer.unref?.()
      }
    })
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params: params ?? {} })
  }

  close() {
    if (this.exited) return
    try { this.child.stdin?.end() } catch { /* best-effort */ }
    try { this.child.kill() } catch { /* best-effort */ }
  }
}
