// The pure rules of a live set-up change (#2004): what a set-up says, whose
// held input survives it, and when the harness may be swapped.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applySetupFields,
  filterHeld,
  heldMessage,
  keepsInput,
  mayDecide,
  MAX_SETUP_ID,
  parseSetup,
  readyToSwap,
  RETIRE_BACKGROUND_GRACE_MS,
  RETIRE_GRACE_MS,
  retireGrace,
  SETUP_APPLY_FALLBACK_MS,
  SETUP_IDLE_SETTLE_MS,
  settledWithin,
  setupExpired,
  setupSignaled,
  setupSpec,
} from '../session-setup.mjs'

test('a set-up needs an id and takes the fields it carries', () => {
  const setup = parseSetup({
    setup_id: 'su-1',
    append_system_prompt: 'shared',
    instructions_scope: 'shared',
    keep_held_from: ' user-1 ',
    answers_from: ' owner-1 ',
    background: 'stop',
  }, 1000)
  assert.equal(setup.id, 'su-1')
  assert.deepEqual(setup.fields, {
    append_system_prompt: 'shared',
    instructions_scope: 'shared',
    opencode_models: null,
    opencode_catalog_live: false,
  })
  assert.equal(setup.keepHeldFrom, 'user-1')
  assert.equal(setup.answersFrom, 'owner-1')
  assert.equal(setup.background, 'stop')
  assert.equal(setup.receivedAt, 1000)
  assert.equal(setup.signaled, false)
  assert.equal(setup.urgent, false)
})

test('a set-up defaults to empty instructions, waiting for background work, and no filter', () => {
  const setup = parseSetup({ setup_id: 'su-1' })
  assert.equal(setup.fields.append_system_prompt, '')
  assert.equal(setup.fields.instructions_scope, '')
  assert.equal(setup.background, 'wait')
  assert.equal(setup.keepHeldFrom, '')
  assert.equal(setup.answersFrom, '')
})

test('a malformed set-up is a 400', () => {
  const bad = [
    null,
    [],
    {},
    { setup_id: '' },
    { setup_id: '   ' },
    { setup_id: 7 },
    { setup_id: 'x'.repeat(MAX_SETUP_ID + 1) },
    { setup_id: 'su', append_system_prompt: 1 },
    { setup_id: 'su', instructions_scope: {} },
    { setup_id: 'su', keep_held_from: 2 },
    { setup_id: 'su', answers_from: ['owner'] },
    { setup_id: 'su', opencode_models: [] },
    { setup_id: 'su', opencode_models: 'x' },
    { setup_id: 'su', opencode_catalog_live: 'yes' },
    { setup_id: 'su', background: 'later' },
  ]
  for (const body of bad) {
    assert.throws(() => parseSetup(body), (err) => err.status === 400, JSON.stringify(body))
  }
})

test("the rebuilt spec is the session's own with the set-up's fields, resuming the conversation", () => {
  const spec = {
    session_id: 's', model: 'm', mcp_servers: { a: {} },
    append_system_prompt: 'private', instructions_scope: 'member:u1',
    opencode_models: { own: {} }, opencode_catalog_live: true, resume_sdk_session_id: 'old',
  }
  const setup = parseSetup({ setup_id: 'su', append_system_prompt: 'shared', instructions_scope: 'shared' })
  const next = setupSpec(spec, setup.fields, 'conv-2')
  assert.equal(next.append_system_prompt, 'shared')
  assert.equal(next.instructions_scope, 'shared')
  assert.equal(next.resume_sdk_session_id, 'conv-2')
  assert.equal('opencode_models' in next, false, "a member's own models go when the set-up has none")
  assert.equal(next.opencode_catalog_live, false)
  assert.equal(next.model, 'm')
  assert.deepEqual(next.mcp_servers, { a: {} })
  assert.equal(spec.append_system_prompt, 'private', 'the old spec is left alone')
  assert.equal(setupSpec(spec, setup.fields, null).resume_sdk_session_id, 'old')
})

test('a starting session takes the fields into the spec its construction reads', () => {
  const spec = { append_system_prompt: 'private' }
  const fields = parseSetup({ setup_id: 'su', append_system_prompt: 'shared', opencode_models: { m: {} }, opencode_catalog_live: true }).fields
  assert.equal(applySetupFields(spec, fields), spec)
  assert.deepEqual(spec, { append_system_prompt: 'shared', instructions_scope: '', opencode_models: { m: {} }, opencode_catalog_live: true })
})

test("keep_held_from keeps that member's input and the control plane's own", () => {
  const owner = { authorId: 'owner', platform: false }
  const member = { authorId: 'member', platform: false }
  const app = { authorId: '', platform: false }
  const platform = { authorId: '', platform: true }
  for (const item of [owner, member, app, platform]) assert.equal(keepsInput('', item), true, 'no filter keeps everything')
  assert.equal(keepsInput('owner', owner), true)
  assert.equal(keepsInput('owner', member), false)
  assert.equal(keepsInput('owner', app), false, "an app's message names nobody")
  assert.equal(keepsInput('owner', platform), true)
  const { kept, dropped } = filterHeld([owner, member, platform, app], 'owner')
  assert.deepEqual(kept, [owner, platform], 'order is kept')
  assert.equal(dropped, 2)
})

test('a set-up applies only once the control plane says so; one that never hears expires', () => {
  const setup = parseSetup({ setup_id: 'su' }, 0)
  assert.equal(SETUP_APPLY_FALLBACK_MS, 120_000)
  assert.equal(setupSignaled(setup), false)
  assert.equal(setupExpired(setup, SETUP_APPLY_FALLBACK_MS - 1), false)
  assert.equal(setupExpired(setup, SETUP_APPLY_FALLBACK_MS), true, 'never applied: the daemon ends the session instead')
  setup.signaled = true
  assert.equal(setupSignaled(setup), true)
  assert.equal(setupExpired(setup, SETUP_APPLY_FALLBACK_MS * 10), false, 'a signaled set-up waits for its turn boundary as long as it takes')
})

// idleSince 0: idle since long ago, so the settle never holds these up.
function session(extra = {}) {
  return { state: 'idle', ending: false, controlBusy: null, pending: new Map(), parks: new Map(), held: [], idleSince: 0, ...extra }
}

test('the swap waits for a turn boundary with nothing waiting on a person', () => {
  const setup = parseSetup({ setup_id: 'su' })
  assert.equal(readyToSwap(session(), setup, 0), true)
  for (const s of [
    session({ state: 'working' }),
    session({ state: 'blocked' }),
    session({ state: 'starting' }),
    session({ ending: true }),
    session({ controlBusy: 'command' }),
    session({ pending: new Map([['r', {}]]) }),
    session({ parks: new Map([['p', {}]]) }),
  ]) {
    assert.equal(readyToSwap(s, setup, 0), false, JSON.stringify({ state: s.state, ending: s.ending, controlBusy: s.controlBusy }))
  }
})

test('background work holds the swap only while nobody waits on it', () => {
  const wait = parseSetup({ setup_id: 'su' })
  assert.equal(readyToSwap(session(), wait, 2), false, 'nobody waits: let the background work finish')
  assert.equal(readyToSwap(session({ held: [{}] }), wait, 2), true, 'held input does not wait on it')
  wait.urgent = true
  assert.equal(readyToSwap(session(), wait, 2), true, 'a refused command does not either')
  assert.equal(readyToSwap(session(), parseSetup({ setup_id: 'su', background: 'stop' }), 2), true)
})

test('a set-up waiting on background work also lets the idle settle (#1613)', () => {
  const wait = parseSetup({ setup_id: 'su' })
  const now = 10_000
  const fresh = session({ idleSince: now - SETUP_IDLE_SETTLE_MS + 1 })
  assert.equal(readyToSwap(fresh, wait, 0, now), false, 'the CLI may be about to start a turn of its own')
  assert.equal(readyToSwap(session({ idleSince: now - SETUP_IDLE_SETTLE_MS }), wait, 0, now), true)
  assert.equal(readyToSwap({ ...fresh, held: [{}] }, wait, 0, now), true, 'held input does not wait for it')
  assert.equal(readyToSwap(fresh, parseSetup({ setup_id: 'su', background: 'stop' }), 0, now), true)
})

test('stopping live background tasks gets the short grace', () => {
  assert.equal(retireGrace(0), RETIRE_GRACE_MS)
  assert.equal(retireGrace(2), RETIRE_BACKGROUND_GRACE_MS)
  assert.ok(RETIRE_BACKGROUND_GRACE_MS < RETIRE_GRACE_MS)
})

test('replayed held input is marked held for the turn bookkeeping (#1837)', () => {
  const visible = { text: 'hi', attachments: [], author: { id: 'u1' }, message_id: 'm1' }
  assert.deepEqual(heldMessage(visible), { ...visible, held: true })
  assert.equal('held' in visible, false, 'the held item is left alone')
})

test('settledWithin gives up at its deadline', async () => {
  assert.equal(await settledWithin(Promise.resolve(true), 50), true)
  assert.equal(await settledWithin(new Promise(() => {}), 10), false)
})

test("while a set-up names answers_from, only that member allows; anyone denies", () => {
  assert.equal(mayDecide('', 'allow', null), true, 'no set-up in flight: as before')
  assert.equal(mayDecide('', 'allow', { id: 'member' }), true)
  assert.equal(mayDecide('owner', 'allow', { id: 'owner' }), true)
  assert.equal(mayDecide('owner', 'allow', { id: 'member' }), false, "a member can't answer the owner's question")
  assert.equal(mayDecide('owner', 'allow', null), false, 'nor an app, or anyone unnamed')
  assert.equal(mayDecide('owner', 'deny', { id: 'member' }), true, 'stopping is anyone')
  assert.equal(mayDecide('owner', 'deny', null), true)
})
