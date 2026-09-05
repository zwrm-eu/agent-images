// Shared sleep semantics (#1493): the validator, the park request and the
// wake text are one implementation, and every harness adapter must reject
// and accept exactly the same inputs before any park is created.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENDING, SLEEP_DESCRIPTION, parkDeadlineError, runSleep, runSleepUntil, sleepSeconds, sleepUntilDeadline } from '../drivers/run-tools.mjs'
import { buildCodexRunTools } from '../drivers/codex-tools.mjs'
import { buildRunTools as buildPiRunTools } from '../drivers/pi-run-tools.mjs'
import { handlePlatformTool } from '../drivers/opencode-run-tools.mjs'
import { fakeHelpers as helpers } from './fake-park.mjs'

const MAX = 21600

const BAD_SECONDS = [undefined, null, 0, -1, 1.5, MAX + 1, '3', 'abc', NaN, Infinity, {}]
const GOOD_SECONDS = [1, 30, MAX]

test('the model-facing text states the cap in seconds and hours', () => {
  assert.match(SLEEP_DESCRIPTION(21600), /max 21600 = 6 hours/)
  assert.match(SLEEP_DESCRIPTION(3600), /max 3600 = 1 hour\)/)
})

test('sleepSeconds accepts only whole seconds within the cap, without coercion', () => {
  for (const v of GOOD_SECONDS) assert.deepEqual(sleepSeconds({ seconds: v }, MAX), { seconds: v })
  for (const v of BAD_SECONDS) {
    const r = sleepSeconds({ seconds: v }, MAX)
    assert.match(r.error, /integer between 1 and 21600/, JSON.stringify(v))
  }
  assert.match(sleepSeconds(undefined, MAX).error, /integer/)
})

test('sleepUntilDeadline validates the timestamp, the past and the cap boundary', () => {
  const now = Date.parse('2026-09-05T12:00:00Z')
  // Offset-less timestamps are refused everywhere, as claude's schema
  // already did: Date.parse would read them as host-local time.
  for (const v of ['nope', 42, undefined, null, '', '2026-09-05T18:00:00', '2026-09-05 18:00:00Z', 'Sat, 05 Sep 2026 18:00:00 GMT']) {
    assert.match(sleepUntilDeadline({ timestamp: v }, MAX, now).error, /invalid timestamp/, JSON.stringify(v))
  }
  assert.equal(sleepUntilDeadline({ timestamp: '2026-09-05T17:00:00.500Z' }, MAX, now).deadline, '2026-09-05T17:00:00.500Z')
  assert.equal(sleepUntilDeadline({ timestamp: '2026-09-05T18:30+05:30' }, MAX, now).deadline, '2026-09-05T13:00:00.000Z', 'offset without seconds')
  assert.match(sleepUntilDeadline({ timestamp: '2026-09-05T18:30+0530' }, MAX, now).error, /invalid timestamp/, 'offset without colon is not the ISO profile Date.parse guarantees')
  assert.match(sleepUntilDeadline({ timestamp: '2026-09-05T11:59:59Z' }, MAX, now).text, /already passed/)
  assert.match(sleepUntilDeadline({ timestamp: '2026-09-05T12:00:00Z' }, MAX, now).text, /already passed/)
  assert.deepEqual(sleepUntilDeadline({ timestamp: '2026-09-05T18:00:00Z' }, MAX, now), {
    timestamp: '2026-09-05T18:00:00Z',
    deadline: '2026-09-05T18:00:00.000Z',
  })
  assert.match(sleepUntilDeadline({ timestamp: '2026-09-05T18:00:01Z' }, MAX, now).error, /capped at 21600 seconds/)
  // An offset timestamp is normalised to UTC in the deadline.
  assert.equal(sleepUntilDeadline({ timestamp: '2026-09-05T15:00:00+02:00' }, MAX, now).deadline, '2026-09-05T13:00:00.000Z')
})

test('parkDeadlineError guards the mechanism against any caller', () => {
  const now = Date.parse('2026-09-05T12:00:00Z')
  assert.equal(parkDeadlineError(undefined, MAX, now), null)
  assert.equal(parkDeadlineError(null, MAX, now), null)
  assert.equal(parkDeadlineError('2026-09-05T12:00:01Z', MAX, now), null)
  assert.equal(parkDeadlineError('2026-09-05T18:00:59Z', MAX, now), null, 'a minute of slack past the cap')
  assert.match(parkDeadlineError('2026-09-05T18:01:01Z', MAX, now), /exceeds the 21600s cap/)
  assert.match(parkDeadlineError('2026-09-05T12:00:00Z', MAX, now), /in the past/)
  assert.match(parkDeadlineError('2020-01-01T00:00:00Z', MAX, now), /in the past/)
  assert.match(parkDeadlineError('nope', MAX, now), /not an ISO-8601 timestamp/)
  assert.match(parkDeadlineError(42, MAX, now), /not an ISO-8601 timestamp/)
})

test('runSleep parks with the canonical payload, deadline and wake text', async () => {
  const parks = []
  const before = Date.now()
  const o = await runSleep({ ending: false }, helpers(parks), { seconds: 30 })
  assert.equal(parks.length, 1)
  assert.equal(parks[0].kind, 'timer')
  assert.deepEqual(parks[0].payload, { seconds: 30 })
  const at = Date.parse(parks[0].deadline)
  assert.ok(at >= before + 30_000 && at <= Date.now() + 30_000, parks[0].deadline)
  assert.match(o.result.content[0].text, /^Woke up: slept 30s \(until .*\)\. Continue the task\.$/)
})

test('runSleep and runSleepUntil refuse an ending session and reject bad input before any park', async () => {
  const parks = []
  assert.deepEqual(await runSleep({ ending: true }, helpers(parks), { seconds: 5 }), { error: ENDING, ending: true })
  assert.deepEqual(await runSleepUntil({ ending: true }, helpers(parks), { timestamp: '2099-01-01T00:00:00Z' }), { error: ENDING, ending: true })
  for (const v of BAD_SECONDS) assert.ok((await runSleep({ ending: false }, helpers(parks), { seconds: v })).error, JSON.stringify(v))
  assert.ok((await runSleepUntil({ ending: false }, helpers(parks), { timestamp: 'nope' })).error)
  assert.ok((await runSleepUntil({ ending: false }, helpers(parks), { timestamp: new Date(Date.now() + (MAX + 60) * 1000).toISOString() })).error)
  assert.match((await runSleepUntil({ ending: false }, helpers(parks), { timestamp: '2020-01-01T00:00:00Z' })).text, /already passed/)
  assert.equal(parks.length, 0, 'nothing may park on refusal or rejection')
})

// Conformance: the same input through every harness adapter yields the same
// verdict, the same park row and the same wake text. Claude's adapter is the
// same dispatcher behind a Zod schema that already enforces the bounds.
function adapters(parks) {
  const s = { ending: false }
  const h = helpers(parks)
  const codex = Object.fromEntries(buildCodexRunTools(s, h).map((t) => [t.spec.name.replace('zwrm__platform__', ''), (args) => t.run(args)]))
  const pi = Object.fromEntries(buildPiRunTools(s, h).map((t) => [t.name, (args) => t.execute('id', args)]))
  const viaHTTP = (name) => async (args) => {
    const r = await handlePlatformTool(s, h, name, args)
    if (r.status !== 200) throw new Error(r.body.error)
    return r.body.text
  }
  const opencode = { sleep: viaHTTP('sleep'), sleep_until: viaHTTP('sleep_until') }
  return { codex, pi, opencode }
}

test('every harness rejects the same sleep inputs and none of them parks', async () => {
  for (const v of BAD_SECONDS) {
    const parks = []
    for (const [name, a] of Object.entries(adapters(parks))) {
      await assert.rejects(() => a.sleep({ seconds: v }), /integer between 1 and 21600/, `${name} ${JSON.stringify(v)}`)
    }
    assert.equal(parks.length, 0, JSON.stringify(v))
  }
})

test('every harness parks the same accepted sleep with the same wake text', async () => {
  for (const v of GOOD_SECONDS) {
    const parks = []
    const texts = []
    for (const a of Object.values(adapters(parks))) texts.push(textOf(await a.sleep({ seconds: v })))
    assert.equal(parks.length, 3)
    for (const p of parks) {
      assert.equal(p.kind, 'timer')
      assert.deepEqual(p.payload, { seconds: v })
    }
    assert.equal(new Set(parks.map((p) => p.deadline.slice(0, 16))).size, 1, 'deadlines agree to the minute')
    for (const t of texts) assert.match(t, new RegExp(`^Woke up: slept ${v}s \\(until .*\\)\\. Continue the task\\.$`))
  }
})

test('every harness applies the same timestamp rules for sleep_until', async () => {
  const parks = []
  const a = adapters(parks)
  const soon = new Date(Date.now() + 60_000).toISOString()
  const far = new Date(Date.now() + (MAX + 60) * 1000).toISOString()
  for (const [name, x] of Object.entries(a)) {
    await assert.rejects(() => x.sleep_until({ timestamp: 'nope' }), /invalid timestamp/, name)
    await assert.rejects(() => x.sleep_until({ timestamp: soon.replace('Z', '') }), /invalid timestamp/, `${name}: offset-less`)
    await assert.rejects(() => x.sleep_until({ timestamp: far }), /capped at 21600 seconds/, name)
    assert.match(textOf(await x.sleep_until({ timestamp: '2020-01-01T00:00:00Z' })), /already passed/, name)
  }
  assert.equal(parks.length, 0)
  for (const x of Object.values(a)) assert.match(textOf(await x.sleep_until({ timestamp: soon })), /Woke up at the requested time/)
  assert.equal(parks.length, 3)
  for (const p of parks) assert.deepEqual(p.payload, { timestamp: soon })
})

// textOf reads the text out of each harness's envelope: codex's tool
// response, pi's content array, or opencode's plain string.
function textOf(r) {
  if (typeof r === 'string') return r
  if (Array.isArray(r?.contentItems)) return r.contentItems.map((c) => c.text).join('\n')
  if (Array.isArray(r?.content)) return r.content.map((c) => c.text).join('\n')
  return JSON.stringify(r)
}
