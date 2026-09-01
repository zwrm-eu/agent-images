import { spawn as nodeSpawn } from 'node:child_process'

export const SHELL_TIMEOUT_MS = 30_000
export const MAX_SHELL_OUTPUT_BYTES = 1 << 20

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/

// The public API accepts command names with or without the familiar leading
// slash, but never accepts whitespace as part of the name. Arguments travel
// separately so a structured invocation cannot accidentally address a
// different command.
export function normalizeCommandName(value) {
  if (typeof value !== 'string') throw new Error('missing command')
  const name = value.trim().replace(/^\/+/, '')
  if (!COMMAND_NAME.test(name)) throw new Error('invalid command name')
  return name
}

// A command-capable driver is the authority for what is invocable. Normalize
// common SDK fields at the daemon boundary so the control-plane DTO stays
// stable across harness and SDK releases.
export function normalizeCommandList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    let name
    try {
      name = normalizeCommandName(raw.name)
    } catch {
      continue
    }
    if (seen.has(name)) continue
    seen.add(name)
    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.flatMap((alias) => {
          try {
            return [normalizeCommandName(alias)]
          } catch {
            return []
          }
        }).filter((alias, index, all) => alias !== name && all.indexOf(alias) === index)
      : []
    const argumentHint = typeof raw.argument_hint === 'string'
      ? raw.argument_hint
      : (typeof raw.argumentHint === 'string' ? raw.argumentHint : '')
    out.push({
      name,
      description: typeof raw.description === 'string' ? raw.description : '',
      argument_hint: argumentHint,
      ...(aliases.length > 0 ? { aliases } : {}),
    })
  }
  return out
}

export function resolveCommand(commands, requested) {
  const name = normalizeCommandName(requested)
  return commands.find((command) => command.name === name || command.aliases?.includes(name)) || null
}

// Command support is a driver capability, not a harness-name allowlist. A
// future driver (for example OpenCode) opts into the shared routes by exposing
// the same two methods Claude exposes today.
export function supportsCommandDriver(driver) {
  return Boolean(driver &&
    typeof driver.listCommands === 'function' &&
    typeof driver.invokeCommand === 'function')
}

// Keep the slash command first in the prompt for drivers whose command syntax
// requires a leading invocation. Pending operator-shell context follows it so
// it is visible to the resulting model turn.
export function commandPrompt(command, argumentsText = '', pendingContext = []) {
  const name = normalizeCommandName(command)
  const args = typeof argumentsText === 'string' ? argumentsText.trim() : ''
  const invocation = `/${name}${args ? ` ${args}` : ''}`
  return pendingContext.length > 0 ? `${invocation}\n\n${pendingContext.join('\n\n')}` : invocation
}

function boundedAppend(state, chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const remaining = state.max - state.bytes
  if (remaining <= 0) {
    state.truncated = true
    return
  }
  if (buf.length <= remaining) {
    state.chunks.push(buf)
    state.bytes += buf.length
    return
  }
  state.chunks.push(buf.subarray(0, remaining))
  state.bytes += remaining
  state.truncated = true
}

// Execute through a fixed shell as the daemon's unprivileged agent account.
// stdout and stderr are combined in arrival order, matching what an operator
// sees in a terminal. Non-zero exits are command outcomes, not transport
// errors, and therefore resolve normally with their exit code and output.
export function executeShellCommand(command, {
  cwd,
  env = process.env,
  timeoutMs = SHELL_TIMEOUT_MS,
  maxOutputBytes = MAX_SHELL_OUTPUT_BYTES,
  spawn = nodeSpawn,
} = {}) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('missing command')
  }
  if (command.includes('\0')) throw new Error('command contains a NUL byte')

  const started = Date.now()
  const output = { chunks: [], bytes: 0, max: maxOutputBytes, truncated: false }
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('/bin/bash', ['-lc', command], {
        cwd,
        env,
        // A timeout must stop the command's whole process tree, not only the
        // bash parent while a pipeline/background child keeps the response
        // pipes open indefinitely.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(err)
      return
    }

    let settled = false
    let timedOut = false
    let hardKill = null
    let timer = null
    const killTree = (signal) => {
      try {
        if (Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // The process may have exited between the timer firing and kill(2).
        try { child.kill(signal) } catch {}
      }
    }
    const finish = (fn) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (hardKill) clearTimeout(hardKill)
      fn()
    }
    child.stdout?.on('data', (chunk) => boundedAppend(output, chunk))
    child.stderr?.on('data', (chunk) => boundedAppend(output, chunk))
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code, signal) => finish(() => resolve({
      command,
      output: Buffer.concat(output.chunks).toString('utf8'),
      exit_code: timedOut ? 124 : (Number.isInteger(code) ? code : 128),
      ...(signal ? { signal } : {}),
      timed_out: timedOut,
      truncated: output.truncated,
      duration_ms: Date.now() - started,
    })))

    timer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
      hardKill = setTimeout(() => killTree('SIGKILL'), 3_000)
      hardKill.unref?.()
    }, timeoutMs)
    timer.unref?.()
  })
}

// A shell call is deliberately an operator-to-model injection channel. The
// durable event keeps a structured payload for API consumers; this marked
// rendering is queued into the next actual model turn without starting a turn
// of its own.
export function shellContext(result) {
  const record = {
    command: result.command,
    output: result.output,
    exit_code: result.exit_code,
    timed_out: Boolean(result.timed_out),
    truncated: Boolean(result.truncated),
    ...(result.signal ? { signal: result.signal } : {}),
  }
  return {
    event: { source: 'operator_shell', ...record, duration_ms: result.duration_ms },
    prompt: '<zwrm-operator-shell-context>\n' +
      'A workspace operator executed this shell command outside the model tool and permission flow. ' +
      'Its command and output are deliberate conversation context for the next turn.\n' +
      `${JSON.stringify(record, null, 2)}\n` +
      '</zwrm-operator-shell-context>',
  }
}
