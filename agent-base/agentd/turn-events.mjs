import { randomUUID } from 'node:crypto'

// Harness-neutral turn identity. Drivers continue translating their native
// streams; the daemon stamps every translated event with this canonical ID.
// Mid-turn steering reuses the open ID, while the next idle -> working edge
// gets a fresh one.
export class TurnEventContext {
  constructor(idFactory = randomUUID) {
    this.idFactory = idFactory
    this.activeTurnId = null
    // An interrupt closes the canonical turn before the provider has fully
    // drained. Keep that retired identity separate from the next active turn
    // so late sdk.* output cannot be mislabeled as belonging to the new work.
    this.drainingTurnId = null
  }

  begin(harness) {
    if (this.activeTurnId) return null
    this.activeTurnId = this.idFactory()
    return {
      turnId: this.activeTurnId,
      payload: { turn_id: this.activeTurnId, harness },
    }
  }

  complete(status = 'completed') {
    if (!this.activeTurnId) return null
    const turnId = this.activeTurnId
    this.activeTurnId = null
    return { turnId, payload: { turn_id: turnId, status } }
  }

  rotate(harness, status = 'completed') {
    const completed = this.complete(status)
    const started = this.begin(harness)
    return { completed, started }
  }

  startDraining(status = 'interrupted') {
    const completed = this.complete(status)
    if (completed) this.drainingTurnId = completed.turnId
    return completed
  }

  finishDraining(turnId) {
    if (this.drainingTurnId === turnId) this.drainingTurnId = null
  }

  implicitEventTurnId(type) {
    // todo.updated derives from a draining turn's sdk.user tool_result and
    // must stay stamped with it, not with whatever turn opened since (#1424).
    if ((type.startsWith('sdk.') || type === 'todo.updated') && this.drainingTurnId) return this.drainingTurnId
    return this.activeTurnId
  }
}
