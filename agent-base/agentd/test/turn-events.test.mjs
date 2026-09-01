import assert from 'node:assert/strict'
import test from 'node:test'
import { TurnEventContext } from '../turn-events.mjs'

for (const harness of ['claude', 'codex', 'pi']) {
  test(`${harness} translated events share one stable canonical turn id`, () => {
    let next = 0
    const turns = new TurnEventContext(() => `canonical-${++next}`)
    const started = turns.begin(harness)
    assert.deepEqual(started, {
      turnId: 'canonical-1',
      payload: { turn_id: 'canonical-1', harness },
    })
    assert.equal(turns.activeTurnId, 'canonical-1')
    assert.equal(turns.begin(harness), null, 'steering must not open a second turn')
    assert.deepEqual(turns.complete('completed'), {
      turnId: 'canonical-1',
      payload: { turn_id: 'canonical-1', status: 'completed' },
    })
    assert.equal(turns.activeTurnId, null)
    assert.equal(turns.begin(harness)?.turnId, 'canonical-2')
  })
}

test('interrupt and terminal completion are explicit and idempotent', () => {
  const turns = new TurnEventContext(() => 'turn-1')
  turns.begin('claude')
  assert.equal(turns.complete('interrupted')?.payload.status, 'interrupted')
  assert.equal(turns.complete('error'), null)
})

test('late sdk output keeps the interrupted turn id while a new turn opens', () => {
  let next = 0
  const turns = new TurnEventContext(() => `turn-${++next}`)
  turns.begin('claude')
  const interrupted = turns.startDraining('interrupted')
  assert.equal(interrupted?.turnId, 'turn-1')

  turns.begin('claude')
  assert.equal(turns.activeTurnId, 'turn-2')
  assert.equal(turns.implicitEventTurnId('sdk.result'), 'turn-1')
  assert.equal(turns.implicitEventTurnId('session.status'), 'turn-2')
  // todo.updated derives from the draining turn's tool_result (#1424) and
  // must stay with it, like the sdk.user it follows.
  assert.equal(turns.implicitEventTurnId('todo.updated'), 'turn-1')

  turns.finishDraining('turn-1')
  assert.equal(turns.implicitEventTurnId('sdk.assistant'), 'turn-2')
  assert.equal(turns.implicitEventTurnId('todo.updated'), 'turn-2')
})

test('rotating a continuously working provider closes and opens canonical turns', () => {
  let next = 0
  const turns = new TurnEventContext(() => `turn-${++next}`)
  turns.begin('claude')
  assert.deepEqual(turns.rotate('claude'), {
    completed: { turnId: 'turn-1', payload: { turn_id: 'turn-1', status: 'completed' } },
    started: { turnId: 'turn-2', payload: { turn_id: 'turn-2', harness: 'claude' } },
  })
})
