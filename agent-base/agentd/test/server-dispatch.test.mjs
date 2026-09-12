// Harness dispatch invariants (#1160).
//
// server.mjs used to construct drivers from two hand-synced sites, and they
// drifted: the seed-gate's deferred path still branched pi-or-claude after
// #1088 added codex, so every codex session on a fresh workspace silently ran
// the CLAUDE harness — surfacing to users as an OpenAI model id rejected by
// Anthropic with 404 model_not_found. The fix is drivers/registry.mjs: ONE
// table that the accepted harness values, the /healthz harness caps, the
// construct dispatch, and the permission-mode policy all derive from.
//
// These tests import the registry for the real invariants, and fall back to
// source text only for the two things that cannot be imported without booting
// the daemon: that server.mjs has no path to a driver constructor except the
// registry, and that the /healthz caps actually spread HARNESS_CAPS instead of
// hand-listing harness names again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DRIVERS, HARNESSES, HARNESS_CAPS, unsupportedPermissionMode } from '../drivers/registry.mjs'
import { SUPPORTED_PERMISSION_MODES as PI_MODES } from '../drivers/pi.mjs'
import { SUPPORTED_PERMISSION_MODES as CODEX_MODES } from '../drivers/codex.mjs'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')
const CLAUDE_DRIVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'drivers', 'claude.mjs')

test('the registry hosts the harnesses this build is known for', () => {
  // Sanity anchor: deriving everything from DRIVERS is only safe if DRIVERS
  // itself still names the harnesses the platform routes.
  for (const h of ['claude', 'pi', 'codex']) {
    assert.ok(HARNESSES.has(h), `registry lost the '${h}' harness`)
  }
})

test('every accepted harness has a construct; nothing else does', () => {
  assert.deepEqual([...HARNESSES].sort(), Object.keys(DRIVERS).sort(),
    'HARNESSES must be derived from DRIVERS, not maintained beside it')
  for (const [h, d] of Object.entries(DRIVERS)) {
    assert.equal(typeof d.construct, 'function', `DRIVERS.${h}.construct must be callable`)
  }
})

test('every harness but claude advertises a same-named cap', () => {
  // state.HarnessDaemonCap on the control plane returns the harness name for
  // pi and codex and "" for claude; the caps the daemon serves must agree or
  // the CP either never routes a hostable harness or routes an unhostable one.
  assert.deepEqual([...HARNESS_CAPS].sort(),
    Object.keys(DRIVERS).filter((h) => h !== 'claude').sort())
})

test('permission-mode policy is the driver modules’ own, by identity', () => {
  // Not equal sets — the SAME objects. The stub and create-time checks read
  // these through the registry; identity means they cannot disagree with what
  // driver construction enforces (the drift behind the #1160 review finding).
  assert.equal(DRIVERS.pi.modes, PI_MODES)
  assert.equal(DRIVERS.codex.modes, CODEX_MODES)
  assert.equal(DRIVERS.claude.modes, null, 'claude hosts every platform mode')
  for (const h of ['pi', 'codex']) {
    assert.ok(DRIVERS[h].modes.has('bypassPermissions'),
      `${h} must host 'bypassPermissions' — every unattended run uses it`)
  }
})

test('the registry rejection reads exactly like the driver’s own', () => {
  // The pre-seed stub and handleCreate throw this instead of the driver's
  // in-construction error; a client must not be able to tell which layer
  // refused it.
  const e = unsupportedPermissionMode('codex', 'plan')
  assert.equal(e.status, 400)
  assert.equal(e.message,
    "the codex harness supports permission modes 'default' and 'bypassPermissions', not 'plan'")
})

test('server.mjs reaches drivers only through the registry', async () => {
  const src = await readFile(SERVER, 'utf8')
  for (const name of ['createPiDriver', 'createCodexDriver', 'createClaudeDriver']) {
    assert.ok(!src.includes(name),
      `server.mjs mentions ${name}; construct only via DRIVERS[harness].construct — ` +
      'a second dispatch site is how codex sessions silently ran claude (#1160)')
  }
})

test('the /healthz caps derive their harness entries from the registry', async () => {
  const src = await readFile(SERVER, 'utf8')
  const capsLine = src.split('\n').find((l) => l.trimStart().startsWith('caps:'))
  assert.ok(capsLine, 'the /healthz caps array must exist')
  assert.match(capsLine, /\.\.\.HARNESS_CAPS/,
    'caps must spread HARNESS_CAPS; a hand-listed harness cap can drift from DRIVERS')
  for (const h of HARNESS_CAPS) {
    assert.ok(!capsLine.includes(`'${h}'`),
      `caps hand-lists '${h}' next to the spread — one source, not two`)
  }
})

test('command routes dispatch by driver capability, not a harness allowlist', async () => {
  const src = await readFile(SERVER, 'utf8')
  assert.match(src, /supportsCommandDriver\(s\.driver\)/,
    'command routes must ask the active driver whether it implements commands')
  assert.doesNotMatch(src, /s\.harness\s*!==\s*['"]claude['"]/,
    'shared command routing must not hard-code the current command-capable harness')
})

test('claude sessions opt in to runtime Bypass mode changes', async () => {
  // Claude's Agent SDK requires this option when the query is constructed;
  // without it, changing an already-running Ask session to
  // bypassPermissions rejects and the daemon returns a generic 500.
  const src = await readFile(CLAUDE_DRIVER, 'utf8')
  assert.match(src, /allowDangerouslySkipPermissions:\s*true/)
})

test('the gateway-token refresh endpoint covers every credential sink (#1363)', async () => {
  // Source-text pin (the handler needs a booted daemon to exercise): the CP
  // gates admission-time refresh on the 'token-refresh' cap, so the cap and
  // the route must ship together, and the handler must rewrite ALL THREE
  // places the create-time token lives — process.env (pi resolves the
  // $ZWRM_GATEWAY_TOKEN apiKey reference per completion), spec.env (a
  // seed-deferred construction re-applies it), and the mcp_servers headers
  // (held by reference by the bridge transports).
  const src = await readFile(SERVER, 'utf8')
  const capsLine = src.split('\n').find((l) => l.trimStart().startsWith('caps:'))
  assert.ok(capsLine.includes("'token-refresh'"), 'the token-refresh cap must be advertised')
  assert.match(src, /action === 'gateway-token'/, 'the gateway-token route must be dispatched')
  assert.match(src, /process\.env\.ZWRM_GATEWAY_TOKEN = token/)
  assert.match(src, /s\.spec\.env = \{ \.\.\.\(s\.spec\.env \|\| \{\}\), ZWRM_GATEWAY_TOKEN: token \}/)
  assert.match(src, /s\.spec\.mcp_servers/)
})

test('an approval that answers no question is refused before the decision is recorded (#1559)', async () => {
  // Source-text pin (handlePermission needs a booted daemon to exercise; the
  // predicate itself is unit-tested in questions.test.mjs): the guard must
  // run on `p.kind === 'question'` BEFORE the pending entry is deleted and
  // the permission.decision event emitted, or the timeline would show
  // "allowed" for a question every driver then refuses.
  const src = await readFile(SERVER, 'utf8')
  const handler = src.slice(src.indexOf('async function handlePermission('), src.indexOf('async function handleParkResolve('))
  const guard = handler.indexOf("body.behavior === 'allow' && p.kind === 'question' && !answeredQuestions(p.input, body.updated_input?.answers)")
  const del = handler.indexOf('s.pending.delete(requestId)')
  const emit = handler.indexOf("s.pusher.emit('permission.decision'")
  assert.ok(guard > 0, 'handlePermission must gate question approvals on answeredQuestions')
  assert.ok(guard < del && guard < emit, 'the guard must precede the delete and the decision event')
  // Every driver stamps kind on its question entries, or the guard is inert:
  // the pending.set call must spread a kind alongside resolve/toolName/input.
  for (const driver of ['claude', 'codex', 'opencode']) {
    const dsrc = await readFile(join(dirname(SERVER), 'drivers', `${driver}.mjs`), 'utf8')
    assert.match(dsrc, /s\.pending\.set\(\w+, \{ resolve, toolName, input[^\n]*\.\.\.\((?:isQuestion|kind) \? \{ kind/,
      `${driver} must stamp kind on its pending entries`)
  }
})
