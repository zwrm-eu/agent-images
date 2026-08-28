// Unit tests for the daemon-enforced tool policies (#1330). Pure function —
// runs with `npm test` (node --test), no VM and no harness. The verdicts
// asserted here are load-bearing for the platform assistant: block = the
// model is refused, confirm = a permission prompt is mandatory in every mode
// (and downgrades to a block on unattended runs, which cannot answer one).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_POLICIES, evaluateToolPolicy } from '../drivers/tool-policy.mjs'

test('platform is the only known policy', () => {
  assert.deepEqual([...TOOL_POLICIES], ['platform'])
})

test('unknown policy blocks everything (fail closed)', () => {
  const v = evaluateToolPolicy('plaform', 'bash', { command: 'zwrm status' })
  assert.equal(v.block, true)
})

test('mcp tools are allowed', () => {
  assert.equal(evaluateToolPolicy('platform', 'mcp__zwrm__save_memory', {}).allow, true)
  assert.equal(evaluateToolPolicy('platform', 'mcp__github__create_issue', {}).allow, true)
})

test('platform park tools are allowed', () => {
  assert.equal(evaluateToolPolicy('platform', 'sleep', {}).allow, true)
  assert.equal(evaluateToolPolicy('platform', 'sleep_until', {}).allow, true)
})

test('native non-bash tools are blocked with a reason naming the policy', () => {
  for (const tool of ['edit', 'write', 'read', 'glob', 'todo_write']) {
    const v = evaluateToolPolicy('platform', tool, {})
    assert.equal(v.block, true, tool)
    assert.match(v.reason, /platform policy/)
  }
})

test('plain zwrm commands are allowed', () => {
  for (const command of [
    'zwrm status',
    'zwrm apps list',
    'zwrm deploy --app web',
    'zwrm logs my-delete-app',
    'zwrm secrets set KEY="two words"',
    '  zwrm postgres list  ',
  ]) {
    assert.equal(evaluateToolPolicy('platform', 'bash', { command }).allow, true, command)
  }
})

test('non-zwrm programs are blocked, including quoted spellings of zwrm', () => {
  for (const command of ['ls', 'curl https://example.com', 'python3 x.py', 'zwrmx status', '"zwrm" status']) {
    assert.equal(evaluateToolPolicy('platform', 'bash', { command }).block, true, command)
  }
})

test('shell chaining, substitution, redirection and globs are blocked', () => {
  for (const command of [
    'zwrm status; rm -rf /',
    'zwrm status && curl evil',
    'zwrm logs app | sh',
    'zwrm status `curl evil`',
    'zwrm status $(curl evil)',
    'zwrm secrets set KEY=$SECRET',
    'zwrm logs app > /tmp/x',
    'zwrm status\ncurl evil',
    'zwrm logs *',
    'zwrm ssh app?',
  ]) {
    assert.equal(evaluateToolPolicy('platform', 'bash', { command }).block, true, command)
  }
})

test('missing or non-string command is blocked', () => {
  assert.equal(evaluateToolPolicy('platform', 'bash', {}).block, true)
  assert.equal(evaluateToolPolicy('platform', 'bash', { command: '' }).block, true)
  assert.equal(evaluateToolPolicy('platform', 'bash', { command: 42 }).block, true)
  assert.equal(evaluateToolPolicy('platform', 'bash', null).block, true)
})

test('destructive words require confirmation at ANY argv position', () => {
  for (const command of [
    'zwrm destroy my-app',
    'zwrm postgres destroy mydb',
    'zwrm volumes delete vol-1',
    'zwrm secrets unset KEY --app web',
    'zwrm --org acme destroy my-app',
    // Depth-3 subcommands the old two-token window provably missed.
    'zwrm postgres backup delete b-123',
    'zwrm volumes snapshot delete s-1',
    'zwrm org secrets unset NAME',
    // Restore overwrites live data.
    'zwrm postgres backup restore latest',
    'zwrm volumes snapshot restore s-1',
    // Flag values shift positions but not the scan.
    'zwrm --org acme postgres destroy mydb',
  ]) {
    const v = evaluateToolPolicy('platform', 'bash', { command })
    assert.equal(v.confirm, true, command)
    assert.equal(Boolean(v.block), false, command)
  }
})

test('quoting cannot disguise a destructive word', () => {
  for (const command of [
    'zwrm "destroy" my-app',
    "zwrm des'troy' my-app",
    'zwrm postgres "delete" x',
  ]) {
    assert.equal(evaluateToolPolicy('platform', 'bash', { command }).confirm, true, command)
  }
})

test('destructive verdicts downgrade to a block on unattended runs', () => {
  const v = evaluateToolPolicy('platform', 'bash', { command: 'zwrm destroy my-app' }, { interactive: false })
  assert.equal(v.block, true)
  assert.match(v.reason, /unattended/)
  // Interactive (and unstated) contexts keep the confirm.
  assert.equal(evaluateToolPolicy('platform', 'bash', { command: 'zwrm destroy my-app' }, { interactive: true }).confirm, true)
  assert.equal(evaluateToolPolicy('platform', 'bash', { command: 'zwrm destroy my-app' }).confirm, true)
})

test('resource names merely containing a destructive word do not trip the scan', () => {
  for (const command of ['zwrm logs my-delete-app', 'zwrm status restore-tool', 'zwrm apps list deleted-things']) {
    assert.equal(evaluateToolPolicy('platform', 'bash', { command }).allow, true, command)
  }
})
