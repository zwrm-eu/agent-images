import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  commandPrompt,
  executeShellCommand,
  normalizeCommandList,
  normalizeCommandName,
  resolveCommand,
  shellContext,
} from '../session-control.mjs'

test('command names stay structured and prompts keep the slash first', () => {
  assert.equal(normalizeCommandName('/review'), 'review')
  assert.throws(() => normalizeCommandName('review now'), /invalid command name/)
  assert.equal(commandPrompt('review', 'src/app.ts', ['shell context']), '/review src/app.ts\n\nshell context')
})

test('SDK command discovery normalizes fields and resolves aliases', () => {
  const commands = normalizeCommandList([
    { name: 'review', description: 'Review code', argumentHint: '<path>', aliases: ['pr'] },
    { name: '/deploy', description: 'Ship it' },
    { name: 'bad name' },
    { name: 'review', description: 'duplicate' },
  ])
  assert.deepEqual(commands, [
    { name: 'review', description: 'Review code', argument_hint: '<path>', aliases: ['pr'] },
    { name: 'deploy', description: 'Ship it', argument_hint: '' },
  ])
  assert.equal(resolveCommand(commands, '/pr')?.name, 'review')
  assert.equal(resolveCommand(commands, 'missing'), null)
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
