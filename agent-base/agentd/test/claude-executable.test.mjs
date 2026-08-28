// Claude executable resolution tests (#1347): harness sessions drive the
// workspace's native claude install (the agent account's ~/.local/bin/claude
// on the volume — the same self-updating binary interactive logins run)
// instead of an SDK-bundled copy, which the image build prunes.
// Resolution uses the ACCOUNT home (passwd), never $HOME: agent secrets may
// define HOME and the boot profile exports it into the daemon before any
// session starts. ZWRM_CLAUDE_BIN is the only env override. A missing
// launcher must throw (the session-create caller surfaces it as an
// API-shaped error), never fall back silently to a binary that isn't there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeExecutable, accountHome } from '../drivers/claude.mjs'

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

test('resolves <account home>/.local/bin/claude by default', async () => {
  const home = await fakeHome()
  assert.equal(resolveClaudeExecutable({}, home), join(home, '.local', 'bin', 'claude'))
})

test('env HOME is ignored — only the account home counts', async () => {
  const account = await fakeHome()
  const poisoned = await fakeHome({ withClaude: false })
  // HOME points at a launcher-less dir; resolution must still use the
  // account home (#1347 review: agent secrets may define HOME).
  assert.equal(
    resolveClaudeExecutable({ HOME: poisoned }, account),
    join(account, '.local', 'bin', 'claude'),
  )
})

test('missing launcher throws with the override hint', async () => {
  const home = await fakeHome({ withClaude: false })
  assert.throws(() => resolveClaudeExecutable({}, home), /ZWRM_CLAUDE_BIN/)
})

test('non-executable launcher throws', async () => {
  const home = await fakeHome({ executable: false })
  assert.throws(() => resolveClaudeExecutable({}, home), /not found or not executable/)
})

test('ZWRM_CLAUDE_BIN override wins over the account home', async () => {
  const home = await fakeHome({ withClaude: false })
  const other = await fakeHome()
  const override = join(other, '.local', 'bin', 'claude')
  assert.equal(resolveClaudeExecutable({ ZWRM_CLAUDE_BIN: override }, home), override)
})

test('ZWRM_CLAUDE_BIN pointing at a missing binary throws (no silent fallback)', async () => {
  const home = await fakeHome() // valid default exists — must NOT be used
  assert.throws(
    () => resolveClaudeExecutable({ ZWRM_CLAUDE_BIN: '/nonexistent/claude' }, home),
    /\/nonexistent\/claude/,
  )
})

test('accountHome returns a non-empty absolute path', () => {
  const h = accountHome()
  assert.ok(h.startsWith('/'), `expected absolute path, got ${h}`)
})
