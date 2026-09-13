import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  commandPrompt,
  executeShellCommand,
  normalizeCommandList,
  normalizeCommandName,
  requireIdle,
  requireNotBusy,
  resolveCommand,
  shellContext,
  supportsCommandDriver,
  supportsModelSwitchDriver,
  withControl,
} from '../session-control.mjs'

test('command names stay structured and prompts keep the slash first', () => {
  assert.equal(normalizeCommandName('/review'), 'review')
  assert.throws(() => normalizeCommandName('review now'), /invalid command name/)
  assert.equal(commandPrompt('review', 'src/app.ts', ['shell context']), '/review src/app.ts\n\nshell context')
})

test('driver command discovery normalizes fields and resolves aliases', () => {
  const commands = normalizeCommandList([
    { name: 'review', description: 'Review code', argumentHint: '<path>', aliases: ['pr'] },
    { name: '/deploy', description: 'Ship it', argument_hint: '[environment]' },
    { name: 'bad name' },
    { name: 'review', description: 'duplicate' },
  ])
  assert.deepEqual(commands, [
    { name: 'review', description: 'Review code', argument_hint: '<path>', aliases: ['pr'] },
    { name: 'deploy', description: 'Ship it', argument_hint: '[environment]' },
  ])
  assert.equal(resolveCommand(commands, '/pr')?.name, 'review')
  assert.equal(resolveCommand(commands, 'missing'), null)
})

test('command support follows driver capabilities, not a harness name', () => {
  const futureOpenCodeDriver = {
    harness: 'opencode',
    listCommands() {},
    invokeCommand() {},
  }
  assert.equal(supportsCommandDriver(futureOpenCodeDriver), true)
  assert.equal(supportsCommandDriver({ harness: 'claude', listCommands() {} }), false)
  assert.equal(supportsCommandDriver({ harness: 'pi' }), false)
})

test('the gates throw 409s carrying the state: finished, busy, or not idle by verb (#1565)', () => {
  const is409 = (message, state) => (err) => err.status === 409 && err.message === message && err.fields.state === state
  assert.doesNotThrow(() => requireIdle({ state: 'idle', controlBusy: null }, 'switching the model'))
  assert.throws(() => requireIdle({ state: 'working', controlBusy: null }, 'invoking a command'),
    is409('session must be idle before invoking a command', 'working'))
  assert.throws(() => requireIdle({ state: 'idle', controlBusy: 'shell' }, 'switching the model'),
    is409('session must be idle before switching the model', 'idle'))
  // A finished session is named as such: "must be idle" would send a
  // retry-until-idle client into a loop that never ends.
  assert.throws(() => requireIdle({ state: 'ended', controlBusy: null }, 'invoking a command'), is409('session is finished', 'ended'))
  // Messages may steer a live turn; only a control call refuses them.
  assert.doesNotThrow(() => requireNotBusy({ state: 'working', controlBusy: null }))
  assert.throws(() => requireNotBusy({ state: 'idle', controlBusy: 'model' }), is409('session is busy with a model request', 'idle'))
})

test('withControl reserves before the first await and releases unless a held call took the turn (#1565)', async () => {
  const s = { state: 'idle', controlBusy: null }
  const pending = withControl(s, 'shell', async () => {
    await new Promise((r) => setTimeout(r, 1))
    return 'done'
  })
  assert.equal(s.controlBusy, 'shell', 'taken synchronously, before the caller\'s first await')
  assert.equal(await pending, 'done')
  assert.equal(s.controlBusy, null)

  // Releases only its own reservation: one another route took meanwhile
  // (a held command turn admitted after an interrupt) is not clobbered.
  const taken = withControl(s, 'shell', async () => {
    await new Promise((r) => setTimeout(r, 1))
    s.controlBusy = 'command'
  })
  await taken
  assert.equal(s.controlBusy, 'command', 'a reservation taken by another route survives our release')
  s.controlBusy = null

  await assert.rejects(withControl(s, 'model', async () => { throw new Error('driver refused') }), /driver refused/)
  assert.equal(s.controlBusy, null, 'a throwing driver releases the reservation')

  // The command turn keeps its reservation until the driver ends the turn.
  assert.deepEqual(await withControl(s, 'command', async () => ({ queued: true }), { hold: true }), { queued: true })
  assert.equal(s.controlBusy, 'command', 'a held success keeps the reservation for the driver to release')
  s.controlBusy = null
  assert.equal(await withControl(s, 'command', async () => null, { hold: true }), null)
  assert.equal(s.controlBusy, null, 'a driver that did not take the turn holds nothing')
  await assert.rejects(withControl(s, 'command', async () => { throw new Error('no such command') }, { hold: true }), /no such command/)
  assert.equal(s.controlBusy, null, 'a failed command releases even with hold')
})

test('model switching follows driver capabilities too (#1552)', () => {
  assert.equal(supportsModelSwitchDriver({ harness: 'codex', setModel() {} }), true)
  assert.equal(supportsModelSwitchDriver({ harness: 'pi' }), false, 'pi binds its model at session start')
  assert.equal(supportsModelSwitchDriver(null), false)
})

test('shell execution combines output and returns non-zero exits as data', async () => {
  const result = await executeShellCommand("printf out; printf err >&2; exit 7")
  assert.match(result.output, /out/)
  assert.match(result.output, /err/)
  assert.equal(result.exit_code, 7)
  assert.equal(result.timed_out, false)

  const context = shellContext(result)
  assert.equal(context.event.source, 'operator_shell')
  assert.match(context.prompt, /outside the model tool and permission flow/)
  assert.match(context.prompt, /"exit_code": 7/)
})

test('shell execution bounds output and runtime', async () => {
  const truncated = await executeShellCommand("printf '1234567890'", { maxOutputBytes: 4 })
  assert.equal(truncated.output, '1234')
  assert.equal(truncated.truncated, true)

  const timed = await executeShellCommand('sleep 5', { timeoutMs: 20 })
  assert.equal(timed.timed_out, true)
  assert.equal(timed.exit_code, 124)
})
