// Live set-up changes (#2004): a chat's sharing changes while its session
// runs, and the session carries on in place on the new set-up. The control
// plane sends the new instructions (POST /v1/sessions/{id}/setup); the daemon
// holds new input from then on, and at the next turn boundary, once the
// control plane has re-seeded the workspace and says so (…/setup/apply) or a
// fallback passes, it stops the harness and starts it again on the new spec,
// resuming the conversation. Same session id, same event stream: clients see
// one session throughout. The pure parts live here; server.mjs owns the
// session and the swap itself.

// How long a pending set-up waits for the control plane's apply. The control
// plane sends it only once the workspace is re-seeded for the new sharing,
// and ends the session itself when that fails; one that never comes means it
// died or gave up, so the daemon ends the session rather than apply a set-up
// that may never have been meant to run, or hold input forever.
export const SETUP_APPLY_FALLBACK_MS = 120_000

// How long the session must have been idle before a set-up that waits for
// background work swaps: a background task's notification makes the claude
// CLI start a turn of its own right after a result (#1613), which the task
// count no longer shows.
export const SETUP_IDLE_SETTLE_MS = 1000

// How often a pending set-up re-checks whether the session reached a turn
// boundary. Cheaper than hooking every path that can leave the session idle.
export const SETUP_POLL_MS = 300

// How long the old harness gets to stop on its own, then after an abort.
// Two harnesses on one transcript must never run, so a swap whose old
// harness outlives both fails the session instead.
export const RETIRE_GRACE_MS = 20_000
export const RETIRE_ABORT_MS = 10_000
// The grace when the swap is stopping live background tasks: a harness keeps
// its input open until they exit (the claude SDK for up to 600s), so waiting
// out the full grace would only delay the abort it ends in.
export const RETIRE_BACKGROUND_GRACE_MS = 3000

export const MAX_SETUP_ID = 128

export const SWITCHING_MESSAGE =
  "the session is switching to the chat's new sharing; try again in a moment"
export const UNDELIVERED_MESSAGE = "the chat's sharing changed; this message was not delivered"
export const OWNER_ANSWERS_MESSAGE = "only the chat's owner can answer this until the chat's new sharing takes effect"

const BACKGROUND = new Set(['wait', 'stop'])

function invalid(message) {
  const e = new Error(message)
  e.status = 400
  return e
}

// parseSetup validates a POST /setup body into the pending set-up the
// session records. Throws a 400-status error on a bad shape.
export function parseSetup(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('invalid setup body')
  const id = body.setup_id
  if (typeof id !== 'string' || id.trim() === '') throw invalid('missing setup_id')
  if (id.length > MAX_SETUP_ID) throw invalid(`setup_id is too long (max ${MAX_SETUP_ID})`)
  for (const f of ['append_system_prompt', 'instructions_scope', 'keep_held_from', 'answers_from']) {
    if (body[f] != null && typeof body[f] !== 'string') throw invalid(`${f} must be a string`)
  }
  const models = body.opencode_models
  if (models != null && (typeof models !== 'object' || Array.isArray(models))) {
    throw invalid('opencode_models must be an object')
  }
  if (body.opencode_catalog_live != null && typeof body.opencode_catalog_live !== 'boolean') {
    throw invalid('opencode_catalog_live must be a boolean')
  }
  const background = body.background ?? 'wait'
  if (!BACKGROUND.has(background)) throw invalid('background must be "wait" or "stop"')
  return {
    id,
    fields: {
      append_system_prompt: body.append_system_prompt ?? '',
      instructions_scope: body.instructions_scope ?? '',
      opencode_models: models ?? null,
      opencode_catalog_live: body.opencode_catalog_live === true,
    },
    keepHeldFrom: (body.keep_held_from ?? '').trim(),
    // Who alone may allow what the turn still running on the old set-up asks
    // until the swap is done; anyone may deny.
    answersFrom: (body.answers_from ?? '').trim(),
    background,
    receivedAt: now,
    // Set by the control plane's apply, once the workspace is re-seeded.
    signaled: false,
    // Someone is waiting on the session (a command, the shell): the swap
    // stops waiting for background tasks.
    urgent: false,
  }
}

// applySetupFields writes a set-up's fields into spec in place: the session
// a seeding home still defers is constructed from that object.
export function applySetupFields(spec, fields) {
  spec.append_system_prompt = fields.append_system_prompt
  spec.instructions_scope = fields.instructions_scope
  spec.opencode_catalog_live = fields.opencode_catalog_live
  if (fields.opencode_models) spec.opencode_models = fields.opencode_models
  else delete spec.opencode_models
  return spec
}

// setupSpec is the spec the rebuilt harness starts from: the session's own,
// with the set-up's fields, resuming the conversation it was in.
export function setupSpec(spec, fields, resumeHandle) {
  const next = applySetupFields({ ...spec }, fields)
  if (resumeHandle) next.resume_sdk_session_id = resumeHandle
  return next
}

// retireGrace is how long the old harness gets to stop on its own.
export function retireGrace(backgroundTasks) {
  return backgroundTasks > 0 ? RETIRE_BACKGROUND_GRACE_MS : RETIRE_GRACE_MS
}

// heldMessage is the visible message of held input, replayed: marked held so
// the control plane, which counts input acknowledged when its message.context
// arrives, knows this one arrived late and can't say whose turn it opened
// (#1837).
export function heldMessage(visible) {
  return { ...visible, held: true }
}

// mayDecide reports whether a permission decision may stand while a set-up
// with answers_from is in flight: the turn still running is on the old
// set-up (a private chat's, with its owner's memories in the prompt), so an
// approval or a question's answer — free text the model acts on — is only its
// owner's to give. Stopping it is anyone's.
export function mayDecide(answersFrom, behavior, decidedBy) {
  return !answersFrom || behavior !== 'allow' || decidedBy?.id === answersFrom
}

// keepsInput reports whether held input survives a set-up's keep_held_from:
// the control plane's own messages always do; anything else only from that
// member (an app's message names nobody, so it doesn't).
export function keepsInput(keepFrom, item) {
  if (!keepFrom || item.platform) return true
  return item.authorId === keepFrom
}

// filterHeld splits held input by keep_held_from.
export function filterHeld(held, keepFrom) {
  const kept = []
  let dropped = 0
  for (const item of held) {
    if (keepsInput(keepFrom, item)) kept.push(item)
    else dropped++
  }
  return { kept, dropped }
}

// setupSignaled reports whether the control plane said the set-up may apply.
export function setupSignaled(setup) {
  return setup.signaled
}

// setupExpired reports a set-up whose apply never came in time.
export function setupExpired(setup, now = Date.now()) {
  return !setup.signaled && now - setup.receivedAt >= SETUP_APPLY_FALLBACK_MS
}

// readyToSwap reports whether the session is at a turn boundary the swap may
// take: idle (which a session still seeding never is), no control call,
// nothing waiting on a person or a timer. When nobody waits on it, the swap
// also waits for the harness's background tasks (a subagent's work would die
// with the harness) and for the idle to settle; once input is held, the
// set-up says "stop", or a caller is waiting, it doesn't.
export function readyToSwap(s, setup, backgroundTasks, now = Date.now()) {
  if (s.ending || s.state !== 'idle' || s.controlBusy) return false
  if (s.pending.size > 0 || s.parks.size > 0) return false
  if (setup.background === 'stop' || s.held.length > 0 || setup.urgent) return true
  return backgroundTasks === 0 && now - (s.idleSince || 0) >= SETUP_IDLE_SETTLE_MS
}

// settledWithin resolves to promise's value, or to false once ms pass.
export function settledWithin(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
