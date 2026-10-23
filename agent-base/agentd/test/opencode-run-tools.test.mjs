// Run-tool dispatch (#1392): validation and park semantics over an injected
// parkTurn, without booting the daemon. The channel itself (file tool →
// long-poll → park) was probed against the real binary with a 65s hold.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { RUN_TOOL_NAMES, handlePlatformTool } from '../drivers/opencode-run-tools.mjs'
import { SLEEP_DESCRIPTION, SLEEP_UNTIL_DESCRIPTION, TASK_ID_PATTERN, WAIT_FOR_TASK_DESCRIPTION } from '../drivers/run-tools.mjs'
import { fakeHelpers as deps } from './fake-park.mjs'

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'opencode-tools')
const DOCKERFILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'Dockerfile')

test('the tool names double as the baked filenames', () => {
  assert.deepEqual(RUN_TOOL_NAMES, ['sleep', 'sleep_until', 'wait_for_task'])
  // Every name has its file and every file is a name: a tool the daemon
  // cannot dispatch, or a dispatch with no file behind it, fails here.
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort()
  assert.deepEqual(files, [...RUN_TOOL_NAMES].sort())
})

test('each baked file tool tells the model what the other harnesses do, and calls its own endpoint', () => {
  // The file tools run in OpenCode's Bun runtime and cannot import the
  // shared text, so it is pinned here: at the 6-hour cap the daemon ships.
  const want = {
    sleep: SLEEP_DESCRIPTION(21600),
    sleep_until: SLEEP_UNTIL_DESCRIPTION(21600),
    wait_for_task: WAIT_FOR_TASK_DESCRIPTION(21600),
  }
  for (const [name, description] of Object.entries(want)) {
    const src = readFileSync(join(TOOLS_DIR, `${name}.ts`), 'utf8')
    const m = src.match(/description:\s*"([^"]*)"/)
    assert.ok(m, `${name}.ts has no description`)
    assert.equal(m[1], description, `${name}.ts`)
    assert.ok(src.includes(`\${process.env.ZWRM_PLATFORM_TOOLS_URL}/${name}\``), `${name}.ts must call /${name}`)
  }
  // The id check is the shared one, so OpenCode's own schema refuses what
  // the daemon would.
  const wait = readFileSync(join(TOOLS_DIR, 'wait_for_task.ts'), 'utf8')
  assert.ok(wait.includes(`.regex(/${TASK_ID_PATTERN}/)`), 'wait_for_task.ts must check the id with TASK_ID_PATTERN')
  assert.match(wait, /\.max\(21600\)\s*\.optional\(\)/, 'timeout_seconds is optional and capped')
})

test('the image bakes wait_for_task alone into the chat tasks root, with the plugin it imports', () => {
  const src = readFileSync(DOCKERFILE, 'utf8')
  assert.match(src, /^COPY opencode-tools\/ \/etc\/opencode\/run\/tool\/$/m, 'every tool goes to the run root')
  assert.match(src, /^COPY opencode-tools\/wait_for_task\.ts \/etc\/opencode\/session-tasks\/tool\/$/m,
    'only wait_for_task goes to the session-tasks root')
  assert.match(src, /npm install --prefix \/etc\/opencode\/session-tasks @opencode-ai\/plugin@/)
  assert.match(src, /test -d \/etc\/opencode\/session-tasks\/node_modules\/@opencode-ai\/plugin/)
  // The session-tasks plugin pin is the run root's.
  const pins = [...src.matchAll(/npm install --prefix \/etc\/opencode\/(\S+) @opencode-ai\/plugin@(\S+)/g)]
  assert.deepEqual(pins.map((m) => m[1]).sort(), ['run', 'session-tasks'])
  assert.equal(new Set(pins.map((m) => m[2])).size, 1, 'one plugin version for both roots')
})

test('wait_for_task parks a task park and returns the resolution or the still-running text', async () => {
  const s = { ending: false, spec: { interactive: true, task_waits: true } }
  const parks = []
  const r = await handlePlatformTool(s, deps(parks), 'wait_for_task', { id: 'task_abc', timeout_seconds: 60 })
  assert.equal(r.status, 200)
  assert.match(r.body.text, /^Stopped waiting after 60s: the task is still running\./)
  assert.equal(parks.length, 1)
  assert.equal(parks[0].kind, 'task')
  assert.deepEqual(parks[0].payload, { task_id: 'task_abc', seconds: 60 })

  const told = await handlePlatformTool(s, deps([], 21600, 'Task task_abc finished: done.'), 'wait_for_task', { id: 'task_abc' })
  assert.deepEqual(told, { status: 200, body: { text: 'Task task_abc finished: done.' } })

  for (const bad of [{}, { id: 'abc' }, { id: 'task_abc', timeout_seconds: 0 }, { id: 'task_abc', timeout_seconds: '60' }, { id: 'task_abc', timeout_seconds: 21601 }]) {
    assert.equal((await handlePlatformTool(s, deps([]), 'wait_for_task', bad)).status, 400, JSON.stringify(bad))
  }
  assert.equal((await handlePlatformTool({ ...s, ending: true }, deps([]), 'wait_for_task', { id: 'task_abc' })).status, 409)
})

test('the endpoint serves only the tools the session spec gives it', async () => {
  const run = { interactive: false }
  const chatTasks = { interactive: true, task_waits: true }
  assert.equal((await handlePlatformTool({ ending: false, spec: run }, deps([]), 'wait_for_task', { id: 'task_abc' })).status, 404)
  assert.equal((await handlePlatformTool({ ending: false, spec: chatTasks }, deps([]), 'sleep', { seconds: 5 })).status, 404)
  assert.equal((await handlePlatformTool({ ending: false, spec: { interactive: true } }, deps([]), 'wait_for_task', { id: 'task_abc' })).status, 404)
  assert.equal((await handlePlatformTool({ ending: false, spec: { ...run, task_waits: true } }, deps([]), 'wait_for_task', { id: 'task_abc' })).status, 200)
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
  // /etc/opencode/run` (and /etc/opencode/session-tasks, for wait_for_task).
  // Extend them together when a tool needs a new import.
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
