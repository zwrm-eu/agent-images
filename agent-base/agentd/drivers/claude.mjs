// Claude harness driver (#1063): the Claude Agent SDK half of a session,
// extracted verbatim from server.mjs. Behavior is intentionally identical to
// the pre-driver daemon — event names, payload shapes, error classification,
// and the #913 turn-ledger idle derivation all carry over unchanged.

import { accessSync, openSync, readSync, closeSync, constants as fsConstants } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { applyTaskMessage, countBackgroundTasks } from './claude-tasks.mjs'
import { createTodoTracker } from './todos.mjs'
import { claudeQuestionDecision, claudeQuestionInput } from './questions.mjs'
import { permissionDecisionPayload } from '../event-payloads.mjs'
import { commandPrompt, normalizeCommandList, resolveCommand, pendingWithTimeout } from '../session-control.mjs'
import { SLEEP_DESCRIPTION, SLEEP_UNTIL_DESCRIPTION, runSleep, runSleepUntil, mapOutcome } from './run-tools.mjs'

// A compaction is one model call over the whole context (#1553); generous
// so a long transcript on a slow model completes, bounded so a CLI that
// never answers does not hold the session's reservation forever.
const COMPACT_TIMEOUT_MS = 5 * 60_000
// The CLI reports a compaction's end as a status message right after its
// boundary; a boundary with no status behind it still counts after this.
const COMPACT_STATUS_GRACE_MS = 2_000
// How long a finished manual compaction waits for the CLI's result for the
// local command, so it is consumed here rather than landing on the timeline
// as a turn of its own (whether the CLI sends one is not promised).
const COMPACT_RESULT_GRACE_MS = 5_000

const CLOSED = Symbol('closed')

// Feeds the SDK's AsyncIterable prompt: HTTP message posts push, the input
// generator awaits. Closing ends the SDK session after the current turn.
class PromiseQueue {
  constructor() {
    this.items = []
    this.waiters = []
    this.closed = false
  }
  push(item) {
    if (this.closed) return false
    const w = this.waiters.shift()
    if (w) w(item)
    else this.items.push(item)
    return true
  }
  close() {
    this.closed = true
    for (const w of this.waiters.splice(0)) w(CLOSED)
  }
  next() {
    if (this.items.length > 0) return Promise.resolve(this.items.shift())
    if (this.closed) return Promise.resolve(CLOSED)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

// resolveClaudeExecutable picks the claude CLI binary for SDK sessions
// (#1347). The workspace's native install (~/.local/bin/claude — on the
// volume, self-updating) is the SAME binary interactive logins run: one
// installation, floating, so a CLI release never needs an image generation.
// The SDK's own bundled copies are pruned at image build and must not be
// relied on. ZWRM_CLAUDE_BIN is the ops escape hatch if an upstream CLI
// release ever breaks the SDK wire — point sessions at a known-good binary
// without a rebuild. The throw propagates to the session-create caller (same
// contract as SDK option validation); the daemon's seed gate has cleared by
// the time a harness spawns, so a missing launcher means a genuinely broken
// volume, not an in-progress seed.
//
// The launcher lives under the AGENT ACCOUNT's home (the native install is
// always seeded at /home/agent/.local/bin/claude), so resolution uses the
// passwd home from userInfo(), NOT $HOME — agent secrets may legitimately
// define a HOME variable, and the boot profile exports it into this process
// before any session starts (#1347 review). ZWRM_CLAUDE_BIN remains the only
// env-driven override, and it is explicit.
export function accountHome() {
  try {
    const h = userInfo().homedir
    if (h) return h
  } catch {
    // no passwd entry for the daemon's uid — fall through
  }
  return '/home/agent'
}

export function resolveClaudeExecutable(env = process.env, home = accountHome()) {
  const p = env.ZWRM_CLAUDE_BIN || join(home, '.local', 'bin', 'claude')
  try {
    accessSync(p, fsConstants.X_OK)
  } catch {
    throw new Error(
      `claude executable not found or not executable at ${p} — ` +
        `the workspace's native claude install is missing or broken ` +
        `(set ZWRM_CLAUDE_BIN to point at an alternative binary)`,
    )
  }
  return p
}

// classifyRunError turns a raw SDK/child-process death into a human-readable
// cause the operator can act on (#793), keeping the raw string as `detail`.
// The Agent SDK surfaces the claude subprocess dying as
// "...terminated by signal SIGKILL" or a non-zero exit — opaque to a user
// staring at a failed run. A SIGKILL that this daemon lives to report is
// overwhelmingly a GUEST out-of-memory kill of the workload: a VM teardown
// would take the daemon down too (no event), and the platform's own stop
// paths (interrupt/end) never SIGKILL the child. dmesg/kmsg confirmation
// strengthens the detail but the heuristic stands without it.
function classifyRunError(err) {
  // Full stack (incl. frames/paths) drives the pattern match, but the
  // user-facing fallback message uses the SHORT message — a stack trace must
  // never render verbatim in the operator's timeline (#793 review).
  const raw = String(err?.stack || err?.message || err)
  const shortMsg = String(err?.message || err)
  if (/SIGKILL|signal\s*9\b/i.test(raw)) {
    const oom = readOOMEvidence()
    return {
      cause: 'oom',
      message: 'The agent ran out of memory and was killed. Retry with a larger VM size.',
      detail: oom ? `${raw}\n${oom}` : raw,
    }
  }
  const sig = raw.match(/terminated by signal (\w+)/i)
  if (sig) {
    return {
      cause: 'crashed',
      message: `The agent process was terminated (${sig[1]}). See the session timeline for its last action.`,
      detail: raw,
    }
  }
  const exit = raw.match(/exit(?:ed)?(?:\s*(?:code|status))?\s+(\d+)/i)
  if (exit && exit[1] !== '0') {
    return {
      cause: 'crashed',
      message: `The agent process crashed (exit ${exit[1]}). See the session timeline for its last action.`,
      detail: raw,
    }
  }
  return { cause: 'error', message: shortMsg, detail: raw }
}

// readOOMEvidence best-effort scrapes the guest kernel log for the most recent
// oom-killer record, to enrich an OOM error's detail. Non-root reads of
// /dev/kmsg are often permitted in the guest; any failure just yields null (the
// SIGKILL heuristic already classifies OOM).
function readOOMEvidence() {
  try {
    // O_NONBLOCK is essential: a blocking read of /dev/kmsg parks waiting for
    // the NEXT kernel message once the ring buffer drains, which would hang
    // the error emission (and the runLoop catch) forever. With it, the read
    // that reaches the end throws EAGAIN and the scan stops.
    const fd = openSync('/dev/kmsg', fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    try {
      const buf = Buffer.alloc(1 << 16)
      const lines = []
      // /dev/kmsg yields one record per read; a short bounded scan is enough.
      for (let i = 0; i < 2000; i++) {
        let n
        try {
          n = readSync(fd, buf, 0, buf.length, null)
        } catch {
          break // EAGAIN at the end of the ring buffer, or EPIPE on overrun
        }
        if (!n) break
        const line = buf.toString('utf8', 0, n)
        if (/Out of memory|oom-kill|Killed process/i.test(line)) lines.push(line.trim())
      }
      return lines.length ? lines.slice(-3).join('\n') : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

// buildPlatformServer exposes the in-process platform tools (#803) to the SDK
// session. These are lifecycle-coupled (they block the turn and survive a VM
// snapshot), which is exactly why they live here and not on the MCP gateway.
// Unattended runs only: an interactive session (spec.interactive) has a live
// consumer on the event stream — replies are delivered directly and sleeping
// would park the VM mid-conversation — so it gets no platform server at all.
function buildPlatformServer(s, h) {
  return createSdkMcpServer({
    name: 'platform',
    version: h.VERSION,
    tools: [
      tool(
        'sleep',
        SLEEP_DESCRIPTION(h.MAX_SLEEP_SECONDS),
        { seconds: z.number().int().min(1).max(h.MAX_SLEEP_SECONDS).describe('How long to sleep, in seconds') },
        ({ seconds }) => claudeOutcome(h, runSleep(s, h, { seconds })),
      ),
      tool(
        'sleep_until',
        SLEEP_UNTIL_DESCRIPTION(h.MAX_SLEEP_SECONDS),
        { timestamp: z.iso.datetime({ offset: true }).describe('ISO-8601 timestamp with a timezone, e.g. 2026-07-10T18:00:00Z') },
        ({ timestamp }) => claudeOutcome(h, runSleepUntil(s, h, { timestamp })),
      ),
    ],
  })
}

// claudeOutcome maps a run-tools outcome (#1493) onto the MCP tool result:
// a rejection is an error result, text is a plain result, and a park
// resolution is returned as-is. The Zod schema above rejects bad shapes
// before dispatch; run-tools re-checks so every harness agrees.
async function claudeOutcome(h, pending) {
  return mapOutcome(await pending, {
    error: (o) => h.textResult(o.error, true),
    text: (text) => h.textResult(text),
    park: (result) => result,
  })
}

// createClaudeDriver wires the Claude Agent SDK to a session. Throws (with
// .status when client-caused) if the SDK session cannot start; the caller owns
// publishing the session and emitting session.started.
//
// h (helpers) supplies the shared machinery still owned by server.mjs:
// { log, syncToDisk, setState, isDone, textResult, parkTurn,
//   isEscalatedTool, VERSION, MAX_SLEEP_SECONDS }
export function createClaudeDriver(s, spec, h) {
  const inputQueue = new PromiseQueue()
  // consumed counts input items handed to the SDK. The SDK's input pump is
  // EAGER (streamInput pops the queue within a microtask of a push), so
  // inputQueue.items.length alone says nothing at a turn boundary — the
  // idle decision snapshots this counter instead (#913).
  let consumed = 0
  let q = null
  // supportedCommands() is the initialize-time list; commands_changed is the
  // authoritative replacement when Claude discovers a skill/repo command
  // later in the session.
  let latestCommands = null
  // A command's optional model is a per-turn override. Capture the current
  // model via getContextUsage(), restore it at the result/interrupt boundary,
  // and only then release server.mjs's exclusive command admission flag.
  let commandTurn = null
  // A manual compaction in flight (#1553): the CLI marks it with a
  // compact_boundary (the counts) and a status message (success or the
  // error), and may answer the local command with a result, which is
  // consumed here rather than treated as a turn.
  let pendingCompact = null
  let compactInstructions = ''
  let compactCounts = null
  let compactGrace = null
  let awaitingCompactResult = false
  let compactResultSlot = null

  // Task-list ledger (#1424): TodoWrite calls become durable todo.updated
  // events once their tool_result confirms the list was actually adopted.
  const todoTracker = createTodoTracker((todos) => s.pusher.emit('todo.updated', { todos }))

  const canUseTool = async (toolName, input, opts = {}) => {
    // After /end, the in-flight turn may still reach for another tool; a new
    // pending prompt would wedge the wind-down forever, so deny immediately
    // (no permission.request event — there is nobody left to answer it).
    if (s.ending) {
      return { behavior: 'deny', message: 'session ended', interrupt: false }
    }
    // Autonomous runs (#731) execute unattended: auto-approve every tool
    // except the connectors the agent's policy marks for escalation. Interactive
    // sessions fall through and prompt for everything (a human is watching the
    // timeline). When nothing escalates, the CP keeps permissionMode
    // 'bypassPermissions' and this callback is never invoked at all.
    if (spec.auto_approve && !h.isEscalatedTool(toolName, spec.escalate_servers)) {
      return { behavior: 'allow' }
    }
    const requestId = randomUUID()
    // A question rides the permission channel in the one platform shape
    // (#1559): positional ids on the way out, answers keyed by them on the
    // way back and re-keyed by question text for the SDK. kind: question is
    // the harness-neutral discriminator (#1555).
    const isQuestion = toolName === 'AskUserQuestion'
    const platformInput = isQuestion ? claudeQuestionInput(input) : input
    s.pusher.emit('permission.request', {
      request_id: requestId,
      tool_name: toolName,
      input: platformInput,
      tool_use_id: opts.toolUseID,
      ...(isQuestion ? { kind: 'question' } : {}),
      ...(typeof opts.decisionReason === 'string' ? { decision_reason: opts.decisionReason } : {}),
    })
    // Parked on a human decision: for the control plane the session is now
    // quiescent, so mark it 'blocked' — the idle-suspend loop may snapshot the
    // VM (preserving this promise) at zero compute cost (#731).
    h.setState(s, 'blocked')
    // Resolved by POST /permissions/{request_id}; the SDK keeps the tool call
    // paused for as long as this promise stays pending (a browser approval can
    // take minutes). The abort signal fires on interrupt/session teardown.
    const decision = await new Promise((resolve) => {
      s.pending.set(requestId, { resolve, toolName, input: platformInput, ...(isQuestion ? { kind: 'question' } : {}), ts: Date.now() })
      opts.signal?.addEventListener(
        'abort',
        () => {
          if (s.pending.delete(requestId)) {
            s.pusher.emit('permission.decision', permissionDecisionPayload(requestId, { behavior: 'cancel' }))
            resolve({ behavior: 'deny', message: 'canceled', interrupt: false })
          }
          h.resumeIfUnblocked(s)
        },
        { once: true },
      )
    })
    return isQuestion ? claudeQuestionDecision(input, platformInput, decision) : decision
  }

  // One claude installation per workspace (#1347): drive the volume's native
  // install instead of an SDK-bundled copy, so harness and interactive
  // sessions run the same (self-updating) version. Logged so the floating
  // version spread stays observable fleet-wide (the CLI's exact version
  // arrives in the sdk.system init event).
  const claudeExecutable = resolveClaudeExecutable()
  h.log(`claude session: using CLI at ${claudeExecutable}`)

  const options = {
    cwd: spec.cwd || process.env.HOME || '/home/agent',
    env: { ...process.env, ...(spec.env || {}) },
    pathToClaudeCodeExecutable: claudeExecutable,
    includePartialMessages: true,
    permissionMode: spec.permission_mode || 'bypassPermissions',
    // The Agent SDK refuses both an initial bypass mode and a later
    // setPermissionMode('bypassPermissions') unless this construction-time
    // opt-in is present. Setting it does not itself bypass anything — the
    // permissionMode above remains authoritative — but it lets an interactive
    // session's Ask/Bypass selector work for the lifetime of the SDK query.
    allowDangerouslySkipPermissions: true,
    // AskUserQuestion blocks on a human answer; an unattended run has none —
    // and at SDK 0.3.201 it auto-resolves with EMPTY answers (claude-code
    // #30983), so the model would continue on fabricated certainty. A bare
    // name in disallowedTools removes the tool from the model's context
    // entirely. Interactive sessions keep it: it surfaces through the
    // permission flow, which carries answers via updated_input.
    ...(spec.interactive ? {} : { disallowedTools: ['AskUserQuestion'] }),
    // The Agent SDK defaults to an EMPTY system prompt and no settings files.
    // Interactive sessions want stock Claude Code behavior: the claude_code
    // preset plus the seeded ~/.claude/CLAUDE.md platform instructions ('user')
    // and the repo's CLAUDE.md ('project').
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      ...(spec.append_system_prompt ? { append: spec.append_system_prompt } : {}),
    },
    settingSources: ['user', 'project'],
    canUseTool,
    stderr: (line) => h.log('[claude stderr]', line),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.resume_sdk_session_id ? { resume: spec.resume_sdk_session_id } : {}),
    ...(spec.effort ? { extraArgs: { effort: spec.effort } } : {}),
    // Connector tools (#730): the CP passes SDK mcpServers entries verbatim —
    // typically one http entry (gateway endpoint + platform bearer token).
    // Tool calls surface as mcp__{server}__{tool} through canUseTool. The
    // in-process 'platform' server (#803) is mounted for unattended runs
    // only; the name stays reserved either way (the CP refuses connectors
    // slugged 'platform').
    mcpServers: (() => {
      const servers = { ...(spec.mcp_servers || {}) }
      // Platform tools are unattended-run machinery; interactive sessions
      // (spec.interactive, see buildPlatformServer) don't get them.
      if (!spec.interactive) {
        if (servers.platform) h.log(`warning: connector server 'platform' is shadowed by the platform tools`)
        servers.platform = buildPlatformServer(s, h)
      }
      return servers
    })(),
  }

  async function* input() {
    for (;;) {
      const item = await inputQueue.next()
      if (item === CLOSED) return
      consumed++
      // A control item (#1553: the compact command) is not a turn: the
      // session stays idle, held by the daemon's reservation instead.
      if (item.__control) {
        const { __control, ...plain } = item
        yield plain
        continue
      }
      // A real prompt after a compaction owns every later result.
      awaitingCompactResult = false
      // Consuming an input item means a turn is starting (or steering is
      // flowing into a running one — setState no-ops then). This is the
      // working-side half of the status derivation (#913): it heals the
      // transient idle when a message lands in the instant around a result.
      h.setState(s, 'working')
      yield item
    }
  }

  // A synchronous throw here (option validation, spawn setup) propagates to
  // the caller, which owns not publishing a half-initialized session.
  q = query({ prompt: input(), options })

  async function listCommands() {
    if (latestCommands === null) {
      latestCommands = normalizeCommandList(await q.supportedCommands())
    }
    return latestCommands.map((command) => ({
      ...command,
      ...(command.aliases ? { aliases: [...command.aliases] } : {}),
    }))
  }

  async function finishCommandTurn() {
    const turn = commandTurn
    if (!turn) return
    commandTurn = null
    try {
      if (turn.restoreModel) await q.setModel(turn.model)
    } catch (err) {
      h.log(`command model restore failed: ${err?.message || err}`)
    } finally {
      s.controlBusy = null
    }
  }

  function compactedPayload(msg) {
    const meta = msg.compact_metadata || {}
    return {
      ...(Number.isFinite(meta.pre_tokens) ? { pre_tokens: meta.pre_tokens } : {}),
      ...(Number.isFinite(meta.post_tokens) ? { post_tokens: meta.post_tokens } : {}),
    }
  }

  // The CLI marks every compaction with a compact_boundary system message,
  // manual and automatic alike, and closes a manual one with a status
  // message (compact_result success/failed). A manual one someone asked for
  // is recorded when it succeeds, outside any turn, with the instructions
  // it ran with; any other boundary is the harness compacting on its own and
  // is recorded as such, so the timeline is honest about where context moved.
  function onCompactBoundary(msg) {
    const trigger = msg.compact_metadata?.trigger === 'manual' ? 'manual' : 'auto'
    if (pendingCompact && trigger === 'manual') {
      compactCounts = compactedPayload(msg)
      // The status message normally follows at once; a CLI that sends none
      // still compacted.
      clearTimeout(compactGrace)
      compactGrace = setTimeout(() => finishCompact('success'), COMPACT_STATUS_GRACE_MS)
      compactGrace.unref?.()
      return
    }
    s.pusher.emit('context.compacted', { trigger, ...compactedPayload(msg) })
  }

  function onCompactStatus(msg) {
    if (!pendingCompact || !msg.compact_result) return
    finishCompact(msg.compact_result, msg.compact_error)
  }

  function finishCompact(result, error) {
    clearTimeout(compactGrace)
    compactGrace = null
    const waiting = pendingCompact
    if (!waiting) return
    pendingCompact = null
    if (result !== 'success') {
      const e = new Error(`the harness did not compact${error ? `: ${String(error).slice(0, 300)}` : ''}`)
      e.status = 409
      waiting.reject(e)
      return
    }
    const payload = {
      trigger: 'manual',
      ...(compactInstructions ? { instructions: compactInstructions } : {}),
      ...(compactCounts || {}),
    }
    compactCounts = null
    // Explicit null: a compaction is not a turn (the daemon syncs before
    // answering).
    s.pusher.emit('context.compacted', payload, { turnId: null })
    waiting.resolve(payload)
  }

  function rejectPendingCompact(message, status = 502) {
    if (!pendingCompact) return
    clearTimeout(compactGrace)
    compactGrace = null
    const waiting = pendingCompact
    pendingCompact = null
    const e = new Error(message)
    e.status = status
    waiting.reject(e)
  }

  function queueMessage(text) {
    if (inputQueue.closed) return false
    inputQueue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: s.sdkSessionId || '',
    })
    h.setState(s, 'working')
    return true
  }

  async function runLoop() {
    try {
      for await (const msg of q) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init' && msg.session_id) {
              s.sdkSessionId = msg.session_id
            }
            if (msg.subtype === 'commands_changed') {
              latestCommands = normalizeCommandList(msg.commands)
            }
            if (msg.subtype === 'compact_boundary') onCompactBoundary(msg)
            if (msg.subtype === 'status') onCompactStatus(msg)
            // Background-task ledger (#1251). A settle that drains the ledger
            // while the session is already idle is re-announced: the CP
            // deferred run completion on the earlier idle status (it carried a
            // non-zero count), and with the turn over nothing else would ever
            // emit the zero it is waiting for. Raw emit — setState suppresses
            // same-state transitions (precedent: the interrupt-raced result
            // re-emit below).
            {
              const hadBackground = countBackgroundTasks(s.backgroundTasks) > 0
              applyTaskMessage(s.backgroundTasks, msg)
              if (hadBackground && s.state === 'idle' && countBackgroundTasks(s.backgroundTasks) === 0) {
                s.pusher.emit('session.status', { state: 'idle', background_tasks: 0 })
              }
            }
            s.pusher.emit('sdk.system', msg)
            break
          case 'assistant':
            s.pusher.emit('sdk.assistant', msg)
            todoTracker.onAssistant(msg)
            break
          case 'user':
            s.pusher.emit('sdk.user', msg)
            todoTracker.onToolResult(msg)
            break
          case 'result': {
            // The CLI's answer to the compact command (#1553): not a turn.
            // Before any boundary it means nothing was compacted; after one
            // it is consumed so it never lands on the timeline as a turn.
            if (awaitingCompactResult) {
              awaitingCompactResult = false
              if (pendingCompact) {
                const text = typeof msg.result === 'string' && msg.result.trim() ? msg.result.trim().slice(0, 300) : ''
                rejectPendingCompact(text ? `the harness did not compact: ${text}` : 'the harness did not compact', 409)
              }
              compactResultSlot?.resolve(msg)
              await h.syncToDisk()
              break
            }
            s.lastResult = {
              subtype: msg.subtype,
              duration_ms: msg.duration_ms,
              num_turns: msg.num_turns,
              total_cost_usd: msg.total_cost_usd,
              usage: msg.usage,
            }
            // Snapshot the consumption counter BEFORE the sync: anything the
            // SDK pulls during that (up to seconds long) window arrived after
            // the CLI's turn already ended, so it starts a NEW turn — flipping
            // idle then would stamp a live turn idle, and nothing would ever
            // flip it back (both 'working' setStates no-op mid-'working').
            const consumedBefore = consumed
            // The transcript must be durable BEFORE the result is observable:
            // for a session-plane run the CP reacts to sdk.result by tearing
            // the VM down (#888).
            await h.syncToDisk()
            const resultIsDraining = h.isTurnDraining(s)
            s.pusher.emit('sdk.result', msg)
            // handleInterrupt owns the idle decision for an aborted provider
            // turn. A fresh message may already have opened canonical turn B;
            // this retired result must neither close nor rotate that turn.
            if (resultIsDraining) break
            // A result is the SDK's stopping point; the only question is
            // whether more input arrived. Input consumed BEFORE this result
            // was incorporated into the turn it closes (queued-message
            // steering semantics) — no per-message turn ledger: messages sent
            // mid-turn are steering and never produce their own result, so
            // counting them wedges the session in 'working' forever (#913).
            if (inputQueue.items.length === 0 && consumed === consumedBefore) {
              // Idle statuses carry the live background-task count (#1251):
              // a non-zero count tells the CP to defer run completion (the
              // VM release would kill the tasks) until the drain re-emit.
              const bg = countBackgroundTasks(s.backgroundTasks)
              if (s.state === 'idle') {
                // An interrupt flipped the session idle while the result was
                // still syncing, so its idle event outran this result and the
                // CP evaluated run completion without it. Re-emit so the CP
                // re-evaluates with the result recorded.
                s.pusher.emit('session.status', { state: 'idle', background_tasks: bg })
              } else {
                h.setState(s, 'idle', { background_tasks: bg })
              }
            } else {
              // The eager input pump consumed a prompt after the provider
              // ended this CLI turn but before sync(1) returned. Keep the
              // session working while rotating the canonical boundary so the
              // newly consumed prompt is not attributed to the old turn.
              h.rotateTurn(s)
            }
            // Release command exclusivity only after the idle/rotate boundary
            // is emitted. A message admitted between sdk.result and idle would
            // otherwise become steering and make the synchronous caller wait
            // for an unrelated second result.
            await finishCommandTurn()
            break
          }
          case 'stream_event':
            s.pusher.emit('sdk.partial', msg, { ephemeral: true })
            break
          default:
            // Forward unknown SDK message types durably rather than dropping
            // them: the CP/UI can ignore what it doesn't know.
            s.pusher.emit('sdk.' + msg.type, msg)
        }
      }
      // Sync BEFORE the state flip: shutdown() waits on isDone(s), and the
      // moment the state is terminal it may drain and exit — the state set and
      // the terminal emit must stay adjacent so isDone always implies the
      // terminal event is queued.
      rejectPendingCompact('session ended', 409)
      await h.syncToDisk()
      s.state = 'ended'
      s.backgroundTasks.clear() // the SDK process is winding down; its tasks die with it
      s.pusher.emit('session.ended', { sdk_session_id: s.sdkSessionId, last_result: s.lastResult })
    } catch (err) {
      h.log(`session ${s.id} failed: ${err?.stack || err}`)
      rejectPendingCompact('session failed', 502)
      await finishCommandTurn()
      const c = classifyRunError(err)
      // Best-effort even on the error path: the CP may still tear the VM down,
      // and whatever transcript exists is worth keeping resumable. Synced
      // before the state flip for the same isDone invariant as above.
      await h.syncToDisk()
      s.state = 'error'
      s.backgroundTasks.clear()
      s.pusher.emit('session.error', { message: c.message, cause: c.cause, detail: c.detail })
    }
  }

  return {
    harness: 'claude',

    start() {
      runLoop()
    },

    // queueMessage returns false when the session no longer accepts input
    // (post-/end); the caller renders the 409.
    queueMessage,

    listCommands,

    async invokeCommand({ command, arguments: argumentsText, model, pendingContext }) {
      const commands = await listCommands()
      const resolved = resolveCommand(commands, command)
      if (!resolved) {
        const available = commands.map((item) => item.name)
        const e = new Error(
          `unknown command '${command}'${available.length ? ` (available: ${available.join(', ')})` : ''}`,
        )
        e.status = 400
        throw e
      }

      let previousModel
      let restoreModel = false
      if (model) {
        // The restore target is the session's durable model first (#1552:
        // spec.model follows a persistent switch); the SDK's live model is
        // the fallback for a session on the CLI default, where an undefined
        // restore correctly resets to that default.
        const usage = await q.getContextUsage()
        previousModel = spec.model || usage?.model || undefined
        await q.setModel(model)
        restoreModel = true
      }
      commandTurn = { restoreModel, model: previousModel }
      const prompt = commandPrompt(command, argumentsText, pendingContext)
      if (!queueMessage(prompt)) {
        await finishCommandTurn()
        return null
      }
      return {
        command: resolved.name,
        visible: commandPrompt(command, argumentsText),
      }
    },

    async interrupt() {
      rejectPendingCompact('compaction interrupted', 409)
      // Parks are canceled by handleInterrupt (shared machinery) before the
      // driver is invoked — no park may be pending here.
      // Snapshot before the awaits: a message consumed during the interrupt
      // or the sync below is a fresh turn the idle flip must not clobber
      // (#913).
      const consumedBefore = consumed
      try {
        await q.interrupt()
        if (inputQueue.items.length === 0 && consumed === consumedBefore) {
          // This idle can complete a run CP-side (a result from an earlier
          // turn suffices) and trigger teardown — make whatever the aborted
          // turn appended to the transcript durable first (#888).
          await h.syncToDisk()
          if (consumed === consumedBefore) {
            // Interrupt does NOT clear the ledger: the harness kills
            // background subagents (their settle messages drain it) but
            // background shells survive the interrupt and stay counted.
            h.setState(s, 'idle', { background_tasks: countBackgroundTasks(s.backgroundTasks) })
          }
        }
      } catch (err) {
        h.log(`interrupt failed: ${err?.message || err}`)
      } finally {
        await finishCommandTurn()
      }
    },

    async setPermissionMode(mode) {
      await q.setPermissionMode(mode)
    },

    // Persistent model switch (#1552): the SDK query runs in streaming-input
    // mode, so setModel is legal at any turn boundary and leaves the
    // transcript intact — the same call /command uses for its override,
    // minus the restore. Effort is refused: it rides extraArgs at query()
    // construction and the SDK has no setter, so honouring it would mean a
    // new query resuming the same session (the CP refuses it first; this is
    // the VM-side guarantee). Empty = keep. The daemon calls this only while
    // idle and outside a command turn, so no restore is pending to undo.
    async setModel({ model, effort }) {
      if (effort) {
        const e = new Error("the claude harness fixes the reasoning effort for the session's lifetime")
        e.status = 400
        throw e
      }
      if (model) {
        await q.setModel(model)
        spec.model = model
      }
    },

    // Manual compaction (#1553): the CLI's own /compact, queued as a user
    // message (the SDK has no compact control verb), completes with a
    // compact_boundary. Whether a result follows the local command in
    // stream-json mode is not something the SDK types promise, so the state
    // is settled here either way: a result flips idle on its own; without
    // one, idle is restored after a short grace unless new input arrived.
    async compact({ instructions } = {}) {
      // The daemon's reservation keeps a second call out; this is the
      // driver's own invariant, not a route.
      if (pendingCompact) throw Object.assign(new Error('a compaction is already in flight'), { status: 409 })
      const slot = pendingWithTimeout(COMPACT_TIMEOUT_MS, 'compaction timed out')
      pendingCompact = slot
      compactInstructions = instructions || ''
      compactCounts = null
      if (inputQueue.closed) {
        rejectPendingCompact('session is not accepting input', 409)
      } else {
        // A control item: consumed without the working flip a prompt gets.
        awaitingCompactResult = true
        inputQueue.push({
          __control: true,
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: `/compact${instructions ? ` ${instructions}` : ''}` }] },
          parent_tool_use_id: null,
          session_id: s.sdkSessionId || '',
        })
      }
      const payload = await slot.promise
      if (awaitingCompactResult) {
        const resultSlot = pendingWithTimeout(COMPACT_RESULT_GRACE_MS, 'no result')
        resultSlot.promise.catch(() => {})
        compactResultSlot = resultSlot
        await resultSlot.promise.catch(() => {})
        compactResultSlot = null
        awaitingCompactResult = false
      }
      return payload
    },

    // Graceful end: the current turn finishes (an abrupt stop is what
    // /interrupt is for). The caller has already set s.ending and canceled
    // pending permissions/parks.
    beginEnd() {
      rejectPendingCompact('session ended', 409)
      inputQueue.close()
    },

    // Daemon shutdown: stop input, abort the in-flight turn. The caller
    // handles pending cancellation and waits for the terminal emit.
    async shutdownStop() {
      rejectPendingCompact('daemon shutting down', 409)
      inputQueue.close()
      try {
        await q?.interrupt()
      } catch {
        // best-effort
      } finally {
        await finishCommandTurn()
      }
    },
  }
}
