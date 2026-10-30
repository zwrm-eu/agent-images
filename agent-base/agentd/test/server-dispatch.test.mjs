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

// handlerBody returns the source of one top-level `async function <name>(`
// in server.mjs, up to the next top-level function, for the source-text pins
// below (the handlers need a booted daemon to exercise). Fails loudly on an
// unknown name rather than slicing to end-of-file.
function handlerBody(src, name) {
  const start = src.indexOf(`\nasync function ${name}(`)
  assert.notEqual(start, -1, `server.mjs has no async function ${name}`)
  const next = src.slice(start + 1).search(/\n(async )?function \w+\(/)
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next)
}

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

test('session startup and callbacks use the credential broker', async () => {
  const src = await readFile(SERVER, 'utf8')
  assert.match(src, /startSession\(withImageServers\(await broker.activate\(spec\), image, log\)\)/)
  // The pusher lives in its own module (#1631); the daemon hands it the broker,
  // and a pusher that stops for good ends its session (#1664) rather than
  // leaving turns to run where no client can see them.
  assert.match(src, /new EventPusher\(spec\.callback_url, spec\.session_id, \{ broker, log, onStopped: \(reason\) => endUndeliverable\(s, reason\) \}\)/)
  const end = src.slice(src.indexOf('\nfunction endUndeliverable('), src.indexOf('\nfunction readMemFreeMB('))
  assert.ok(end.length > 0, 'server.mjs must define endUndeliverable')
  for (const step of [/if \(isDone\(s\) \|\| s\.ending\) return/, /s\.ending = true/, /cancelPendingPermissions\(s,/, /cancelPendingParks\(s,/, /s\.driver\?\.beginEnd\(\)/]) {
    assert.match(end, step, `endUndeliverable must end the session like handleEnd: ${step}`)
  }
  // …stops a live turn rather than let it run unseen, and says so in
  // /healthz, where the control plane finalizes the row it will never hear
  // ended.
  assert.match(end, /s\.undeliverable = reason/)
  assert.match(end, /s\.driver\.interrupt\(\)/)
  // codex and opencode finish on the turn's result, which the interrupt
  // suppresses: the wind-down is started again once the turn is over.
  assert.match(end, /if \(!isDone\(s\)\) s\.driver\.beginEnd\(\)/)
  // Recorded before the early return: an End during the refusal streak must
  // not leave the lost session.ended unreported.
  assert.ok(end.indexOf('s.undeliverable = reason') < end.indexOf('if (isDone(s) || s.ending) return'))
  assert.match(src, /undeliverable_session: session\?\.undeliverable \? session\.id : null/)
  const pusher = await readFile(join(dirname(SERVER), 'event-pusher.mjs'), 'utf8')
  assert.match(pusher, /this\.broker\.request\(this\.url/)
  assert.doesNotMatch(src, /callback_token|handleGatewayToken/)
  assert.match(src, /'agent-identity'/)
})

test('the model-switch endpoint ships with its cap and applies only between turns (#1552)', async () => {
  // Source-text pin (handleModel needs a booted daemon to exercise; the
  // per-driver setModel is covered by the codex/opencode driver tests): the
  // CP gates the switch on the 'model-switch' cap, so the cap and the route
  // must ship together; the handler must dispatch by driver capability (pi
  // has no setModel) and refuse while a turn is live, since claude's
  // setModel is a turn-boundary call and codex/opencode read the spec when
  // they OPEN a turn.
  const src = await readFile(SERVER, 'utf8')
  const capsLine = src.split('\n').find((l) => l.trimStart().startsWith('caps:'))
  assert.ok(capsLine.includes("'model-switch'"), 'the model-switch cap must be advertised')
  assert.match(src, /action === 'model' && parts\.length === 4/, 'the model route must be dispatched')
  const handler = handlerBody(src, 'handleModel')
  assert.match(handler, /supportsModelSwitchDriver\(s\.driver\)/, 'the switch must ask the driver, not a harness allowlist')
  assert.match(handler, /s\.pusher\.emit\('session\.model_changed'/, 'the switch must be recorded durably')
})

test('the compact endpoint ships with its cap, runs as a held control call, and records context.compacted outside any turn (#1553)', async () => {
  // Source-text pin (handleCompact needs a booted daemon to exercise; the
  // per-driver compact is covered by the codex/opencode driver tests): the
  // CP gates on the 'compact' cap, so cap and route ship together; the
  // handler dispatches by driver capability, refuses while a turn is live,
  // and records the event with an explicit null turn like the shell — a
  // compaction is not a turn and must never open one.
  const src = await readFile(SERVER, 'utf8')
  const capsLine = src.split('\n').find((l) => l.trimStart().startsWith('caps:'))
  assert.ok(capsLine.includes("'compact'"), 'the compact cap must be advertised')
  assert.match(src, /action === 'compact' && parts\.length === 4/, 'the compact route must be dispatched')
  const handler = handlerBody(src, 'handleCompact')
  assert.match(handler, /supportsCompactDriver\(s\.driver\)/, 'compaction must ask the driver, not a harness allowlist')
  assert.doesNotMatch(handler, /beginTurn|emitUserMessage|pusher\.emit\(/, 'a compaction must not open a turn; the driver writes the record')
  // Every driver records its manual compaction outside any turn.
  for (const name of ['claude', 'codex', 'opencode', 'pi']) {
    const driver = await readFile(new URL(`../drivers/${name}.mjs`, import.meta.url), 'utf8')
    assert.match(driver, /s\.pusher\.emit\('context\.compacted', payload, \{ turnId: null \}\)/, `${name} must record its manual compaction with an explicit null turn`)
  }
})

test('control routes share one between-turns gate and reservation; mode stays outside it (#1565)', async () => {
  // Source-text pin: the gate used to be three hand-rolled copies with three
  // error strings, and the reservation three hand-rolled set/clear pairs. A
  // route that gates itself by hand again is how the copies drifted.
  const src = await readFile(SERVER, 'utf8')
  for (const [name, verb] of [
    ['handleCommand', 'invoking a command'],
    ['handleShell', 'running a shell command'],
    ['handleModel', 'switching the model'],
    ['handleCompact', 'compacting the context'],
  ]) {
    const handler = handlerBody(src, name)
    assert.match(handler, new RegExp(`requireIdle\\(s, '${verb}'\\)`), `${name} must gate through requireIdle`)
    assert.match(handler, /withControl\(s, '/, `${name} must reserve through withControl`)
    assert.doesNotMatch(handler, /s\.controlBusy/, `${name} must not touch the reservation by hand`)
    assert.doesNotMatch(handler, /s\.state !== 'idle'|isDone\(s\)/, `${name} must not re-implement the idle or finished check`)
  }
  // The command turn's reservation outlives the request (the driver releases
  // it at the turn's end); dropping the hold would admit steering messages
  // into a command turn.
  assert.match(handlerBody(src, 'handleCommand'), /\{ hold: true \}/, 'handleCommand must hold the reservation for the turn')
  // Messages refuse on a control call but may steer a live turn.
  const message = handlerBody(src, 'handleMessage')
  assert.match(message, /requireNotBusy\(s\)/, 'handleMessage must gate through requireNotBusy')
  assert.doesNotMatch(message, /requireIdle|s\.controlBusy/, 'handleMessage must not gate on idle or by hand')
  // The deliberate exception, reasoned on handleMode itself.
  assert.doesNotMatch(handlerBody(src, 'handleMode'), /requireIdle|requireNotBusy|withControl|controlBusy/, 'handleMode must stay outside the gate')
})

test('an approval that answers no question is refused before the decision is recorded (#1559)', async () => {
  // Source-text pin (handlePermission needs a booted daemon to exercise; the
  // predicate itself is unit-tested in questions.test.mjs): the guard must
  // run on `p.kind === 'question'` BEFORE the pending entry is deleted and
  // the permission.decision event emitted, or the timeline would show
  // "allowed" for a question every driver then refuses.
  const src = await readFile(SERVER, 'utf8')
  const handler = handlerBody(src, 'handlePermission')
  const guard = handler.indexOf("body.behavior === 'allow' && p.kind === 'question' && !answeredQuestions(p.input, body.updated_input?.answers)")
  const del = handler.indexOf('s.pending.delete(requestId)')
  const emit = handler.indexOf("s.pusher.emit('permission.decision'")
  // #1631: a request whose event went out truncated must not run an
  // updated_input echoed back from it. The decision passes through
  // decisionForRequest, keyed by the same id the drivers emit and park on,
  // and both the recorded and the applied decision are its result.
  const filter = handler.indexOf('const decision = decisionForRequest(p, body, s.pusher.truncatedPermissionRequests.delete(requestId))')
  assert.ok(filter > del && filter < emit, 'handlePermission must filter the decision before recording it')
  assert.match(handler, /permissionDecisionPayload\(requestId, decision\)/)
  assert.match(handler, /updatedInput: decision\.updated_input \?\? p\.input/)
  assert.doesNotMatch(handler, /body\.updated_input \?\? p\.input/)
  for (const driver of ['claude', 'codex', 'opencode', 'pi']) {
    const dsrc = await readFile(join(dirname(SERVER), 'drivers', `${driver}.mjs`), 'utf8')
    assert.match(dsrc, /s\.pusher\.emit\('permission\.request', \{\s*request_id: requestId,/,
      `${driver} must emit permission.request with the request_id decisions arrive with`)
    assert.match(dsrc, /s\.pending\.set\(requestId, /, `${driver} must park the request under that same id`)
  }
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

test('image-declared MCP servers (#1676): advertised, and merged after broker activation', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8')
  const capsLine = src.split('\n').find((l) => l.trimStart().startsWith('caps:'))
  assert.ok(capsLine.includes("'image-mcp'"), 'the image-mcp cap must be advertised')
  // The broker refuses non-platform URLs, so the image's stdio servers must
  // join the spec AFTER activate, never before.
  assert.match(src, /withImageServers\(await broker\.activate\(spec\), image, log\)/)
})

test('desktop (#1680): advertised, routed, and the upgrade path is token-gated', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8')
  const capsLine = src.split('\n').find((l) => l.trimStart().startsWith('caps:'))
  assert.ok(capsLine.includes("'desktop'"), 'the desktop cap must be advertised')
  assert.ok(capsLine.includes("'speaker-attribution'"), 'the speaker-attribution cap must be advertised')
  const up = src.slice(src.indexOf("server.on('upgrade'"), src.indexOf('server.listen(PORT'))
  const relay = up.indexOf('relayVNC(')
  assert.ok(relay > 0, 'the upgrade handler relays to the desktop')
  // Every gate must come before the relay: the daemon token, GET only, the
  // exact path, and the zwrm-vnc upgrade protocol — anything else is refused.
  for (const gate of ['tokenMatches(', "req.method !== 'GET'", "url.pathname !== '/desktop/vnc'", "!== 'zwrm-vnc'"]) {
    const at = up.indexOf(gate)
    assert.ok(at > 0 && at < relay, `upgrade gate ${gate} must run before relayVNC`)
  }
})

test('session-instructions (#1832): advertised, so the CP resumes a chat shared since its conversation began', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8')
  const capsLine = src.split('\n').find((l) => l.trimStart().startsWith('caps:'))
  assert.ok(capsLine.includes("'session-instructions'"), 'the session-instructions cap must be advertised')
})

test('a platform message sent again is dropped before it is queued, and the cap says so (#1910)', async () => {
  const src = await readFile(SERVER, 'utf8')
  const message = handlerBody(src, 'handleMessage')
  // A known id answers at once, before anything is prepared or queued.
  const drop = message.search(/if \(messageId && s\.messageIds\.has\(messageId\)\) return send\(res, 202, \{ queued: true, duplicate: true \}\)/)
  const queue = message.indexOf('s.driver.queueMessage(')
  const refused = message.indexOf("return send(res, 409, { error: 'session is not accepting messages'")
  const remember = message.indexOf('s.messageIds.add(messageId)')
  assert.ok(drop !== -1, 'a known id must return 202 duplicate at once')
  assert.ok(queue !== -1 && refused !== -1 && remember !== -1, 'handleMessage must queue, refuse and remember')
  assert.ok(drop < queue, 'a known id is dropped before queueing')
  assert.ok(refused < remember, 'an id is remembered only after the refusal branch, once its message was taken')
  assert.equal(message.split('s.messageIds.add(').length, 2, 'an id is remembered in one place only')
  assert.match(message, /source: 'platform'/, 'the durable message marks a platform message')
  assert.match(src, /'platform-messages'/, '/healthz must advertise the platform-messages cap')
})

test('claude never auto-approves a question, and keeps the tool for delegate runs (#1912)', async () => {
  const src = await readFile(CLAUDE_DRIVER, 'utf8')
  const isQuestion = src.indexOf("const isQuestion = toolName === 'AskUserQuestion'")
  const autoApprove = src.indexOf('if (!isQuestion && spec.auto_approve')
  assert.ok(isQuestion !== -1 && autoApprove > isQuestion, 'the question check must precede run auto-approve')
  assert.match(src, /asksQuestions\(spec\) \? \{\} : \{ disallowedTools: \['AskUserQuestion'\] \}/)
  assert.match(await readFile(SERVER, 'utf8'), /'task-questions'/)
})

// ---- wait_for_task (#1911) ---------------------------------------------------

const PI_DRIVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'drivers', 'pi.mjs')

test('task-waits (#1911): advertised next to the other caps', async () => {
  const src = await readFile(SERVER, 'utf8')
  const capsLine = src.split('\n').find((l) => l.trimStart().startsWith('caps:'))
  assert.ok(capsLine.includes("'task-waits'"), 'the task-waits cap must be advertised')
  assert.match(src, /\/\/ 'task-waits' \(#1911\)/, 'and explained like the others')
})

test('a member\'s message ends a task wait once it is taken; a platform message does not (#1911)', async () => {
  const src = await readFile(SERVER, 'utf8')
  const message = handlerBody(src, 'handleMessage')
  const cancel = message.indexOf('if (!platform) cancelPendingParks(s, NEW_MESSAGE, NEW_MESSAGE_CANCELS)')
  assert.ok(cancel !== -1, 'handleMessage must cancel task parks for a member\'s message, guarded on the platform source')
  const queue = message.indexOf('s.driver.queueMessage(')
  const refused = message.indexOf("return send(res, 409, { error: 'session is not accepting messages'")
  const emitted = message.indexOf('emitUserMessage(s, visibleMessage)')
  const accepted = message.lastIndexOf('send(res, 202, { queued: true })')
  assert.ok(queue < cancel && refused < cancel && emitted < cancel, 'only once the message is taken and on the timeline')
  assert.ok(cancel < accepted, 'before the 202')
  assert.equal(message.split('cancelPendingParks(').length, 2, 'one cancel in handleMessage')
  assert.match(src, /import \{[^}]*\bNEW_MESSAGE\b[^}]*\bNEW_MESSAGE_CANCELS\b[^}]*\} from '\.\/drivers\/run-tools\.mjs'/)
})

test('park cancellation passes bare reasons and leaves the wording to each park kind (#1911)', async () => {
  const src = await readFile(SERVER, 'utf8')
  // The wording lives in run-tools' parkCancellation, whose tests pin the
  // sleep text byte for byte for exactly these reasons.
  assert.doesNotMatch(src, /sleep aborted|Sleep aborted/, 'server.mjs must not phrase a cancellation itself')
  const reasons = [...src.matchAll(/cancelPendingParks\(s, '([^']*)'\)/g)].map((m) => m[1]).sort()
  assert.deepEqual(reasons, ['daemon shutting down', 'interrupted', 'session ended', 'session event delivery stopped'])
  const start = src.indexOf('\nfunction cancelPendingParks(')
  assert.ok(start !== -1)
  const body = src.slice(start, src.indexOf('\nfunction ', start + 1))
  assert.match(body, /parkCancellations\(s\.parks, reason, kinds\)/)
  assert.match(body, /resolvePark\(s, c\.parkId, c\.resolution, c\.text\)/)
})

test('pi never asks a person to approve a platform tool, and builds them by the spec gate (#1911)', async () => {
  // Source-text pin: the gate lives inside createPiDriver, which needs the
  // pi SDK and a model to construct.
  const src = await readFile(PI_DRIVER, 'utf8')
  assert.match(src, /const platformTools = new Set\(\[\.\.\.platformToolNames\(spec\), TOOL_SEARCH\]\)/)
  const policy = src.indexOf('if (spec.tool_policy) {')
  const allow = src.indexOf('if (platformTools.has(ev.toolName) && !forceConfirm) return undefined')
  const ask = src.indexOf("s.pusher.emit('permission.request'")
  assert.ok(policy !== -1 && allow > policy && ask > allow, 'after the tool policy, before any permission request')
  assert.match(src, /\.\.\.buildRunTools\(s, h, spec\)\]/, 'the tools come from the shared spec gate, not an interactive check')
})

// ---- live set-up change (#2004) ---------------------------------------------
// The swap needs a booted daemon; these pin the wiring the CP relies on.

test("the set-up routes exist and the daemon advertises them as 'session-setup' (#2004)", async () => {
  const src = await readFile(SERVER, 'utf8')
  const capsLine = src.split('\n').find((l) => l.trimStart().startsWith('caps:'))
  assert.match(capsLine, /'session-setup'/)
  assert.match(src, /action === 'setup' && parts\.length === 4\) return await handleSetup\(req, res, s\)/)
  assert.match(src, /action === 'setup' && parts\.length === 5 && parts\[4\] === 'apply'\) return await handleSetupApply\(req, res, s\)/)
})

test('a message during a set-up change is held, never handed to the old harness (#2004)', async () => {
  const src = await readFile(SERVER, 'utf8')
  const message = handlerBody(src, 'handleMessage')
  const held = message.indexOf('if (inputHeld(s)) return holdMessage(res, s, input)')
  assert.ok(held !== -1, 'handleMessage must hold input while a set-up is pending or swapping')
  assert.ok(held < message.indexOf('requireNotBusy(s)'), 'before the busy gate: the swap holds the control reservation')
  assert.ok(held < message.indexOf('s.driver.queueMessage('), 'before the driver sees it')
})

test('commands, the shell, model switches and compactions refuse during a set-up change (#2004)', async () => {
  const src = await readFile(SERVER, 'utf8')
  for (const name of ['handleCommand', 'handleShell', 'handleModel', 'handleCompact']) {
    const body = handlerBody(src, name)
    const refuse = body.indexOf('refuseWhileSwitching(s)')
    assert.ok(refuse !== -1 && refuse < body.indexOf('requireIdle(s, '), `${name} must refuse while switching, before its idle gate`)
  }
})

test('a swap resumes the conversation in the same session and announces itself (#2004)', async () => {
  const src = await readFile(SERVER, 'utf8')
  const swap = handlerBody(src, 'applySetup')
  assert.match(swap, /await retireDriver\(s, retireGrace\(background\)\)/)
  assert.match(swap, /return await abandonDaemon\(s, setup\)/, 'an old harness not confirmed gone never gets a successor')
  assert.match(swap, /constructDriver\(s, spec, s\.helpers\)/)
  assert.match(swap, /'session\.setup_applied'/)
  assert.doesNotMatch(swap, /session\.started/, 'a swap is not a new session')
  assert.ok(swap.indexOf('retireDriver(') < swap.indexOf('constructDriver('), 'the old harness is gone before the new one starts')
})

test('every driver can retire quietly (#2004)', async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drivers')
  for (const h of Object.keys(DRIVERS)) {
    const src = await readFile(join(dir, `${h}.mjs`), 'utf8')
    assert.match(src, /async retire\(\) \{/, `the ${h} driver must implement retire()`)
    assert.match(src, /\n    forceStop\(\) \{/, `the ${h} driver must implement forceStop()`)
    if (h !== 'claude') {
      assert.equal(src.split('if (retiring) return retiring.resolve()').length, 3,
        `the ${h} driver's finish and fail must both resolve a retire instead of ending the session`)
    }
  }
})

test('every wait in a retire is bounded, and one that fails exits the daemon (#2004)', async () => {
  const src = await readFile(SERVER, 'utf8')
  const retire = handlerBody(src, 'retireDriver')
  assert.doesNotMatch(retire, /await d\.(shutdownStop|forceStop)\(\)/, 'the stop must be bounded too')
  assert.equal(retire.split('settledWithin(').length, 4, 'grace, the stop, and the wait after it')
  const abandon = handlerBody(src, 'abandonDaemon')
  assert.ok(abandon.indexOf("'session.error'") < abandon.indexOf('s.pusher.drain(') &&
    abandon.indexOf('s.pusher.drain(') < abandon.indexOf('process.exit(1)'), 'the error reaches the CP before the daemon exits')
})

test('a mode change waits while the chat\'s sharing changes (#2004)', async () => {
  const src = await readFile(SERVER, 'utf8')
  const mode = handlerBody(src, 'handleMode')
  const refuse = mode.indexOf('if (inputHeld(s)) throw switchingConflict(s)')
  assert.ok(refuse !== -1 && refuse < mode.indexOf('s.driver.setPermissionMode('))
  assert.doesNotMatch(mode, /refuseWhileSwitching|requireIdle/, 'mode changes stay outside the idle gate')
  assert.match(mode, /s\.spec\.permission_mode = body\.mode/, 'the swap copies the live mode')
})

test('only the member a turn was set up for explains a refusal while a set-up waits (#2004)', async () => {
  const src = await readFile(SERVER, 'utf8')
  const permission = handlerBody(src, 'handlePermission')
  assert.match(permission, /if \(s\.answersFrom && cleanAuthor\(body\.decided_by\)\?\.id !== s\.answersFrom\) delete body\.message/)
  const setup = handlerBody(src, 'handleSetup')
  assert.match(setup, /s\.answersFrom = setup\.answersFrom \|\| \(inputHeld\(s\) \? s\.answersFrom : ''\)/, 'a later set-up never lifts it')
  assert.ok(setup.indexOf('s.answersFrom =') < setup.indexOf('s.setup = setup'), 'judged before the new set-up counts as held input')
})

test('a set-up never applies without the control plane, and a stale one ends the session (#2004)', async () => {
  const src = await readFile(SERVER, 'utf8')
  const maybe = src.slice(src.indexOf('\nfunction maybeApplySetup('), src.indexOf('\nasync function applySetup('))
  const expired = maybe.indexOf('if (setupExpired(setup)) {')
  assert.ok(expired !== -1 && maybe.indexOf('return endSession(s)') > expired)
  assert.match(maybe, /!setupSignaled\(setup\)\) return/)
  assert.doesNotMatch(src, /setupStartingSession|s\.state === 'starting'\) \{\n\s*setupStarting/, 'a seeding session takes a set-up like a live one')
})

test('replayed held input is marked held, and dropped input forgotten (#2004, #1837)', async () => {
  const src = await readFile(SERVER, 'utf8')
  const replay = src.slice(src.indexOf('\nfunction replayHeld('), src.indexOf('\nfunction failSetup('))
  assert.match(replay, /emitUserMessage\(s, heldMessage\(item\.visible\)\)/)
  assert.match(replay, /forgetHeld\(s, items\.slice\(i\)\)/)
  for (const name of ['dropHeld', 'dropHeldFrom']) {
    const body = src.slice(src.indexOf(`\nfunction ${name}(`), src.indexOf('\n}\n', src.indexOf(`\nfunction ${name}(`)))
    assert.match(body, /forgetHeld\(s, /, `${name} must forget the ids it drops`)
  }
})

test("a chat taken back keeps refusing everyone else's messages for the rest of its session (#2004)", async () => {
  const src = await readFile(SERVER, 'utf8')
  const message = handlerBody(src, 'handleMessage')
  const filter = message.indexOf('if (!keepsInput(s.authorFilter, input)) return send(res, 409, { error: UNDELIVERED_MESSAGE')
  assert.ok(filter !== -1, 'handleMessage must refuse other authors once a set-up named keep_held_from')
  assert.ok(filter < message.indexOf('if (inputHeld(s))'), 'whether or not a set-up is pending')
  assert.ok(filter < message.indexOf('s.driver.queueMessage('))
  const setup = handlerBody(src, 'handleSetup')
  assert.match(setup, /s\.authorFilter = setup\.keepHeldFrom/, 'the latest set-up decides, an empty one clears it')
  const swap = handlerBody(src, 'applySetup')
  assert.doesNotMatch(swap, /authorFilter/, 'applying the set-up never lifts it')
})

test('while a sharing change is in flight only its owner allows what the old turn asks (#2004)', async () => {
  const src = await readFile(SERVER, 'utf8')
  const perm = handlerBody(src, 'handlePermission')
  const gate = perm.indexOf('if (!mayDecide(s.answersFrom, body.behavior, cleanAuthor(body.decided_by))) {')
  assert.ok(gate !== -1 && gate < perm.indexOf('s.pending.delete(requestId)'), 'refused before the request is consumed')
  assert.match(perm, /error: OWNER_ANSWERS_MESSAGE/)
  assert.match(handlerBody(src, 'handleSetup'), /s\.answersFrom = setup\.answersFrom/)
  assert.match(handlerBody(src, 'applySetup'), /s\.answersFrom = ''/, 'cleared once the swap completes')
})
