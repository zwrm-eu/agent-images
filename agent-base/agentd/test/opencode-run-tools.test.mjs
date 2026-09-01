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
