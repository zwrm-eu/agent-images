// Run-tool dispatch (#1392): validation and park semantics over an injected
// parkTurn, without booting the daemon. The channel itself (file tool →
// long-poll → park) was probed against the real binary with a 65s hold.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RUN_TOOL_NAMES, handlePlatformTool } from '../drivers/opencode-run-tools.mjs'

const deps = (parks) => ({
  MAX_SLEEP_SECONDS: 21600,
  parkTurn: async (s, kind, payload, deadline, resultText) => {
    parks.push({ kind, payload, deadline })
    return { content: [{ type: 'text', text: resultText('') }] }
  },
})

test('the tool names double as the baked filenames', () => {
  assert.deepEqual(RUN_TOOL_NAMES, ['sleep', 'sleep_until'])
})

test('sleep validates, parks with a deadline, and returns the wake text', async () => {
  const parks = []
  const r = await handlePlatformTool({ ending: false }, deps(parks), 'sleep', { seconds: 30 })
  assert.equal(r.status, 200)
  assert.match(r.body.text, /Woke up: slept 30s/)
  assert.equal(parks.length, 1)
  assert.equal(parks[0].kind, 'timer')
  assert.deepEqual(parks[0].payload, { seconds: 30 })

  for (const bad of [{}, { seconds: 0 }, { seconds: 1.5 }, { seconds: 21601 }, { seconds: 'x' }]) {
    const e = await handlePlatformTool({ ending: false }, deps([]), 'sleep', bad)
    assert.equal(e.status, 400, JSON.stringify(bad))
  }
})

test('sleep_until validates the timestamp and the 6h cap; the past is a no-op', async () => {
  const parks = []
  const soon = new Date(Date.now() + 60_000).toISOString()
  const r = await handlePlatformTool({ ending: false }, deps(parks), 'sleep_until', { timestamp: soon })
  assert.equal(r.status, 200)
  assert.match(r.body.text, /Woke up at the requested time/)
  assert.equal(parks.length, 1)

  const past = await handlePlatformTool({ ending: false }, deps([]), 'sleep_until', { timestamp: '2020-01-01T00:00:00Z' })
  assert.equal(past.status, 200)
  assert.match(past.body.text, /already passed/)

  const far = new Date(Date.now() + 22000 * 1000).toISOString()
  assert.equal((await handlePlatformTool({ ending: false }, deps([]), 'sleep_until', { timestamp: far })).status, 400)
  assert.equal((await handlePlatformTool({ ending: false }, deps([]), 'sleep_until', { timestamp: 'nope' })).status, 400)
})

test('an ending session refuses to park; unknown tools 404', async () => {
  assert.equal((await handlePlatformTool({ ending: true }, deps([]), 'sleep', { seconds: 5 })).status, 409)
  assert.equal((await handlePlatformTool({ ending: false }, deps([]), 'nope', {})).status, 404)
})

// Baked run tools import at load time inside opencode's Bun runtime, resolved
// by walking node_modules up from /etc/opencode/run/tool. Only what the image
// vendors at /etc/opencode/run/node_modules (the Dockerfile pins
// @opencode-ai/plugin) is resolvable there — a tool importing anything else
// throws "Cannot find module" at SessionPrompt.run and the RUN completes empty
// with no assistant output. The unit suite runs against a fake server and
// cannot catch that, so pin the allowed import set statically: adding a tool
// that imports an un-vendored module fails HERE, not only on real hardware.
test('baked run tools import only the vendored module set (#1392)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'opencode-tools')
  // Kept in lockstep with the Dockerfile's `npm install --prefix
  // /etc/opencode/run`. Extend BOTH together when a tool needs a new import.
  const VENDORED = new Set(['@opencode-ai/plugin'])
  const files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length > 0, 'no run tools found to check')
  // Every module-specifier form Bun would resolve at load time: `from "x"`,
  // side-effect `import "x"`, dynamic `import("x")`, and `require("x")`. A
  // narrower match would let a future tool smuggle an un-vendored import past
  // this guard in a form it does not recognize.
  const specRE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g
  for (const f of files) {
    const src = readFileSync(join(toolsDir, f), 'utf8')
    for (const m of src.matchAll(specRE)) {
      const spec = m[1] || m[2] || m[3] || m[4]
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
      // Bare specifier → a package the image must vendor next to the tools.
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      assert.ok(VENDORED.has(pkg), `${f} imports un-vendored module '${pkg}'; vendor it in the Dockerfile's /etc/opencode/run install or the RUN turn fails at tool resolve`)
    }
  }
})
