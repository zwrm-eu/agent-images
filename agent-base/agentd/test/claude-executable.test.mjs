// Claude executable resolution tests (#1347): harness sessions drive the
// workspace's native claude install (~/.local/bin/claude on the volume — the
// same self-updating binary interactive logins run) instead of an SDK-bundled
// copy, which the image build prunes. ZWRM_CLAUDE_BIN is the ops override.
// A missing launcher must throw (the session-create caller surfaces it as an
// API-shaped error), never fall back silently to a binary that isn't there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeExecutable } from '../drivers/claude.mjs'

async function fakeHome({ withClaude = true, executable = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'claude-exec-'))
  if (withClaude) {
    const bin = join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const launcher = join(bin, 'claude')
    await writeFile(launcher, '#!/bin/sh\nexit 0\n')
    await chmod(launcher, executable ? 0o755 : 0o644)
  }
  return home
}

test('resolves $HOME/.local/bin/claude by default', async () => {
  const home = await fakeHome()
  assert.equal(resolveClaudeExecutable({ HOME: home }), join(home, '.local', 'bin', 'claude'))
})

test('missing launcher throws with the override hint', async () => {
  const home = await fakeHome({ withClaude: false })
  assert.throws(() => resolveClaudeExecutable({ HOME: home }), /ZWRM_CLAUDE_BIN/)
})

test('non-executable launcher throws', async () => {
  const home = await fakeHome({ executable: false })
  assert.throws(() => resolveClaudeExecutable({ HOME: home }), /not found or not executable/)
})

test('ZWRM_CLAUDE_BIN override wins over $HOME', async () => {
  const home = await fakeHome({ withClaude: false })
  const other = await fakeHome()
  const override = join(other, '.local', 'bin', 'claude')
  assert.equal(resolveClaudeExecutable({ HOME: home, ZWRM_CLAUDE_BIN: override }), override)
})

test('ZWRM_CLAUDE_BIN pointing at a missing binary throws (no silent fallback)', async () => {
  const home = await fakeHome() // valid default exists — must NOT be used
  assert.throws(
    () => resolveClaudeExecutable({ HOME: home, ZWRM_CLAUDE_BIN: '/nonexistent/claude' }),
    /\/nonexistent\/claude/,
  )
})
