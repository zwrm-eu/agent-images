// Background-task ledger (#1251): tracks the Claude harness's task lifecycle
// system messages so the daemon can report whether background work (background
// subagents, run_in_background shells) is still live after a turn's result.
// The control plane consults the count before idle-suspending the VM or
// completing a session-plane run — both would silently freeze or kill the
// tasks.
//
// Pure functions over a plain ledger object so it is unit-testable without
// the SDK (claude.mjs constructs `query` directly; there is no injection seam).
//
// Two sources, by CLI (#1712):
//
// LEVEL — background_tasks_changed (SDK 0.3.289): the full set of live
// background tasks, sent whenever the set, a description or an `ambient` flag
// changes. REPLACE semantics, so a missed message is corrected by the next
// one. 2.1.289 lists running and pending tasks that aren't foreground, so the
// set never holds foreground tasks, and a paused task leaves it (the only
// paused tasks are workflows restored after a restart, which aren't running).
// The level is per CLI process and nothing is sent at startup: the reset the
// SDK asks for on every (re)start is the fresh ledger the driver creates with
// its one CLI process. Once a level has arrived, only the level adds entries.
// Settle edges still remove them, so a lost final level can't leave a finished
// task counted. Ordering against the edges of the same transition is
// unspecified (2.1.289 sends the level first, except on some kill paths), and
// both orders converge.
//
// EDGES — for a CLI that predates the level. The fleet's CLI is pinned and
// workspaces switch to it at boot, so today that takes a ZWRM_CLAUDE_BIN
// override. Lifecycle, per SDK 0.3.201:
//   task_started     -> add. Fires for FOREGROUND tasks too (that is how
//                       Ctrl+B finds them); foreground tasks settle via
//                       task_updated {status:'completed'} before the turn's
//                       result, so at idle the ledger holds exactly the
//                       background set.
//   task_progress    -> refresh the entry's clock: a task proving itself
//                       alive must not fall out of the count at the TTL
//                       (which exists for LEAKED entries, not long jobs).
//   task_updated     -> remove when patch.status is terminal (completed/
//                       failed/killed); any other patch refreshes the clock.
//                       'paused' keeps counting — a paused task still holds
//                       guest state worth preserving.
//   task_notification-> remove (any status; emitted at most once per task).
//
// Interrupt must NOT clear the ledger: the harness kills background SUBAGENTS
// on interrupt (they emit their own settle messages), but background SHELLS
// survive it — clearing would undercount live work.

// BACKGROUND_TASK_TTL_MS bounds a leaked edge-tracked entry: the CLI's message
// buffer can evict task_updated settle patches under backlog, and an
// uncounted-forever task would make its VM unsuspendable and defer run
// completion until the run budget. The CLI sends task_progress for subagents,
// workflows and MCP tasks only, never for shells, so without the level a shell
// stops counting 2 h after it starts. Both TTLs are enforced at read time only
// — the CP re-probes on every sweep tick, so expiry needs no timer and no
// event.
export const BACKGROUND_TASK_TTL_MS = 2 * 60 * 60 * 1000

const CLI_TIMEOUT_CAP_MS = 2 ** 31 - 1

// levelTaskTtlMs bounds an entry the level confirmed: the session's shell
// ceiling plus an hour, so a background shell always ends before its entry
// expires. In SDK mode the CLI drops no queued message and settle edges back
// up the final level, so this is a cap more than leak protection: a task the
// CLI never times out (a persistent Monitor) holds the VM awake for at most
// this long after the last change to the background set. Each level listing a
// task restarts its clock.
export function levelTaskTtlMs(env) {
  return shellCeilingMs(env) + 60 * 60 * 1000
}

// shellCeilingMs mirrors how the 2.1.289 CLI bounds a background command's
// `timeout`: max(2 h, BASH_MAX_TIMEOUT_MS, BASH_DEFAULT_TIMEOUT_MS), capped at
// 2^31-1 ms; an unset or non-positive value falls back to 10 min and 2 min.
// The CLI may read a value that isn't a plain integer differently, so such a
// value counts as the cap: keeping a VM awake beats freezing a job.
export function shellCeilingMs(env = {}) {
  const read = (name) => {
    const v = String(env[name] ?? '').trim()
    if (v === '') return null
    if (!/^\d+$/.test(v)) return CLI_TIMEOUT_CAP_MS
    const n = parseInt(v, 10)
    return n > 0 ? n : null
  }
  const def = read('BASH_DEFAULT_TIMEOUT_MS') ?? 2 * 60 * 1000
  const max = read('BASH_MAX_TIMEOUT_MS')
  const bashMax = max === null ? Math.max(10 * 60 * 1000, def) : Math.max(max, def)
  return Math.min(Math.max(2 * 60 * 60 * 1000, bashMax), CLI_TIMEOUT_CAP_MS)
}

const SETTLED_STATUSES = new Set(['completed', 'failed', 'killed'])

// createTaskLedger returns an empty ledger for one CLI process started with
// `env`. `level` records that the process has sent a background_tasks_changed.
export function createTaskLedger(env = {}) {
  return {
    tasks: new Map(), // task_id -> {ts, description}
    level: false,
    levelTtlMs: levelTaskTtlMs(env),
  }
}

// applyTaskMessage folds one SDK message into the ledger. Returns whether the
// ledger's MEMBERSHIP changed (a clock refresh is not a change). Unknown
// types/subtypes are ignored.
export function applyTaskMessage(ledger, msg, now = Date.now()) {
  if (msg?.type !== 'system') return false
  const { tasks } = ledger
  if (msg.subtype === 'background_tasks_changed') {
    if (!Array.isArray(msg.tasks)) return false
    ledger.level = true
    const before = new Set(tasks.keys())
    tasks.clear()
    for (const t of msg.tasks) {
      // Ambient tasks (live-update watchers, skip_transcript tasks) are not
      // activity; the SDK says hosts must exclude them.
      if (typeof t?.task_id !== 'string' || t.ambient === true) continue
      tasks.set(t.task_id, { ts: now, description: t.description || '' })
    }
    return tasks.size !== before.size || [...tasks.keys()].some((id) => !before.has(id))
  }
  if (!msg.task_id) return false
  const refresh = () => {
    const t = tasks.get(msg.task_id)
    if (t) t.ts = now
    return false
  }
  switch (msg.subtype) {
    case 'task_started':
      // Under the level, additions come from the level alone.
      if (ledger.level) return false
      // Ambient tasks (SDK >= 0.3.289: live-update watchers, skip_transcript
      // tasks) are not activity; the SDK says hosts must not count them.
      // Counting one would hold every run open and the VM awake for the TTL.
      if (msg.ambient === true || msg.skip_transcript === true) return false
      tasks.set(msg.task_id, { ts: now, description: msg.description || '' })
      return true
    case 'task_progress':
      return refresh()
    case 'task_updated':
      if (SETTLED_STATUSES.has(msg.patch?.status)) return tasks.delete(msg.task_id)
      return refresh()
    case 'task_notification':
      return tasks.delete(msg.task_id)
    default:
      return false
  }
}

// clearTaskLedger empties the ledger when the CLI process winds down.
export function clearTaskLedger(ledger) {
  ledger.tasks.clear()
}

// countBackgroundTasks reports the live entries, ignoring any past the TTL
// that applies to the ledger's source.
export function countBackgroundTasks(ledger, now = Date.now()) {
  const ttlMs = ledger.level ? ledger.levelTtlMs : BACKGROUND_TASK_TTL_MS
  let n = 0
  for (const t of ledger.tasks.values()) {
    if (now - t.ts < ttlMs) n++
  }
  return n
}
