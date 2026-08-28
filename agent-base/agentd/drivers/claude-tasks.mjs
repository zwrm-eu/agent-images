// Background-task ledger (#1251): tracks the Claude harness's task lifecycle
// system messages so the daemon can report whether background work (background
// subagents, run_in_background shells) is still live after a turn's result.
// The control plane consults the count before idle-suspending the VM or
// completing a session-plane run — both would silently freeze or kill the
// tasks.
//
// Pure functions over a Map so the ledger is unit-testable without the SDK
// (claude.mjs constructs `query` directly; there is no injection seam).
//
// Lifecycle, per SDK 0.3.201:
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

// BACKGROUND_TASK_TTL_MS bounds a leaked entry: the CLI's message buffer can
// evict task_updated settle patches under backlog, and an uncounted-forever
// task would make its VM unsuspendable and defer run completion until the run
// budget. Enforced at read time only — the CP re-probes on every sweep tick,
// so expiry needs no timer and no event.
export const BACKGROUND_TASK_TTL_MS = 2 * 60 * 60 * 1000

const SETTLED_STATUSES = new Set(['completed', 'failed', 'killed'])

// applyTaskMessage folds one SDK message into the ledger. Returns whether the
// ledger's MEMBERSHIP changed (a clock refresh is not a change). Unknown
// types/subtypes are ignored.
export function applyTaskMessage(tasks, msg, now = Date.now()) {
  if (msg?.type !== 'system' || !msg.task_id) return false
  const refresh = () => {
    const t = tasks.get(msg.task_id)
    if (t) t.ts = now
    return false
  }
  switch (msg.subtype) {
    case 'task_started':
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

// countBackgroundTasks reports the live entries, ignoring any past the TTL.
export function countBackgroundTasks(tasks, now = Date.now(), ttlMs = BACKGROUND_TASK_TTL_MS) {
  let n = 0
  for (const t of tasks.values()) {
    if (now - t.ts < ttlMs) n++
  }
  return n
}
