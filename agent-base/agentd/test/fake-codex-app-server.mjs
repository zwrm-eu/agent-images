#!/usr/bin/env node
// A scripted stand-in for `codex app-server`, used by codex-driver.test.mjs.
//
// It speaks the same newline-delimited JSON-RPC the real binary does (verified
// against @openai/codex 0.153.4) and replays a scenario named by
// FAKE_CODEX_SCENARIO, so the driver's turn state machine, approval gate, and
// result contract can be tested without an API key or a network.

import readline from 'node:readline'
import { appendFileSync } from 'node:fs'

const scenario = process.env.FAKE_CODEX_SCENARIO || 'simple'
// Outbound calls are recorded here rather than echoed back as notifications:
// the driver deliberately DROPS notification methods it does not know, so a
// test-only notification would never reach the event stream.
const TRACE = process.env.FAKE_CODEX_TRACE
const trace = (method, params) => {
  if (TRACE) appendFileSync(TRACE, JSON.stringify({ method, params }) + '\n')
}
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

// The fake VALIDATES what it receives. Without this every "the driver sends X"
// assertion checks the driver against itself, and a misspelled field or an
// out-of-set enum value would pass the whole suite and fail on the first real
// turn. Field and enum names below come from `codex app-server generate-ts` on
// the pinned @openai/codex — keep them in step when moving that pin.
const KNOWN = {
  'thread/start': new Set(['allowProviderModelFallback', 'approvalPolicy', 'approvalsReviewer',
    'baseInstructions', 'config', 'cwd', 'developerInstructions', 'dynamicTools', 'environments',
    'ephemeral', 'experimentalRawEvents', 'historyMode', 'mockExperimentalField', 'model',
    'modelProvider', 'multiAgentMode', 'permissions', 'personality', 'projectId',
    'runtimeWorkspaceRoots', 'sandbox', 'selectedCapabilityRoots', 'serviceName', 'serviceTier',
    'sessionStartSource', 'threadSource']),
  'thread/resume': new Set(['approvalPolicy', 'approvalsReviewer', 'baseInstructions', 'config', 'cwd',
    'developerInstructions', 'excludeTurns', 'history', 'initialTurnsPage', 'model', 'modelProvider',
    'path', 'permissions', 'personality', 'runtimeWorkspaceRoots', 'sandbox', 'serviceTier', 'threadId']),
  'turn/start': new Set(['additionalContext', 'approvalPolicy', 'approvalsReviewer',
    'clientUserMessageId', 'collaborationMode', 'cwd', 'cyberAccessProgram', 'effort', 'environments',
    'input', 'model', 'multiAgentMode', 'outputSchema', 'permissions', 'personality',
    'responsesapiClientMetadata', 'runtimeWorkspaceRoots', 'sandboxPolicy', 'serviceTier',
    'serviceTierForTurn', 'summary', 'threadId', 'toolOutput', 'turnTrigger']),
  'turn/steer': new Set(['additionalContext', 'clientUserMessageId', 'expectedTurnId', 'input',
    'responsesapiClientMetadata', 'threadId']),
  'turn/interrupt': new Set(['threadId', 'turnId']),
}
const ENUMS = {
  approvalPolicy: new Set(['untrusted', 'on-failure', 'on-request', 'never']),
  sandbox: new Set(['read-only', 'workspace-write', 'danger-full-access']),
  // The PLATFORM ladder, which is what the driver may legitimately send. Codex
  // itself types ReasoningEffort as an open string in 0.153 and validates it
  // nowhere locally, so this set exists to catch the driver inventing a level,
  // not to mirror a protocol enum. ('minimal' is gone: no model in the pinned
  // lineup offers it. 'ultra' is deliberately absent — codex has it, the
  // platform ladder does not.)
  effort: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
}

class ProtocolError extends Error {}

function validate(method, params) {
  const known = KNOWN[method]
  if (!known) return
  for (const key of Object.keys(params || {})) {
    if (!known.has(key)) throw new ProtocolError(`unknown ${method} param '${key}'`)
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    const v = params?.[key]
    if (v !== undefined && v !== null && !allowed.has(v)) {
      throw new ProtocolError(`invalid ${method} ${key} '${v}'`)
    }
  }
  if (params?.sandboxPolicy && !params.sandboxPolicy.type) {
    throw new ProtocolError(`${method} sandboxPolicy is missing 'type'`)
  }
  for (const item of params?.input || []) {
    if (item?.type === 'text' && !Array.isArray(item.text_elements)) {
      throw new ProtocolError(`${method} text input is missing 'text_elements'`)
    }
  }
}

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const notify = (method, params) => send({ method, params })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Server->client requests we issue, keyed by id, so replies can be awaited.
let nextServerId = 1000
const awaitingReply = new Map()
function ask(method, params) {
  const id = nextServerId++
  return new Promise((resolve) => {
    awaitingReply.set(id, resolve)
    send({ id, method, params })
  })
}

async function runTurn(turnId) {
  notify('turn/started', { threadId: THREAD_ID, turn: { id: turnId, items: [], status: 'inProgress', error: null } })

  if (scenario === 'approval' || scenario === 'approval-denied') {
    const reply = await ask('item/commandExecution/requestApproval', {
      threadId: THREAD_ID, turnId, itemId: 'item-cmd', command: 'rm -rf /', cwd: '/home/agent',
    })
    notify('item/started', {
      threadId: THREAD_ID, turnId,
      item: { type: 'commandExecution', id: 'item-cmd', command: 'rm -rf /', cwd: '/home/agent', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, processId: null },
    })
    const declined = reply?.decision !== 'accept'
    notify('item/completed', {
      threadId: THREAD_ID, turnId,
      item: {
        type: 'commandExecution', id: 'item-cmd', command: 'rm -rf /', cwd: '/home/agent',
        status: declined ? 'declined' : 'completed', commandActions: [],
        aggregatedOutput: declined ? 'denied by user' : 'ok', exitCode: declined ? null : 0, durationMs: 5, processId: null,
      },
    })
  }

  if (scenario === 'user-input') {
    // The AskUserQuestion twin. An unattended run must refuse it, and the
    // refusal arrives as a JSON-RPC error, which we surface as a marker.
    // The protocol's RequestUserInputQuestion shape (codex-rs/protocol/src/
    // request_user_input.rs): id, header, question, isOther, isSecret,
    // options?. The reply must be RequestUserInputResponse — {answers: {[id]:
    // {answers: string[]}}} — which serde would reject in any other form, so
    // the fake marks anything else malformed rather than echo the driver.
    const reply = await ask('item/tool/requestUserInput', {
      threadId: THREAD_ID, turnId, itemId: 'item-q',
      questions: [{ id: 'q1', header: 'Env', question: 'which?', isOther: true, isSecret: false,
        options: [{ label: 'staging', description: 's' }, { label: 'production', description: 'p' }] }],
    })
    const wellFormed = !reply?.__error && reply?.answers && typeof reply.answers === 'object' &&
      Object.values(reply.answers).every((a) => a && Array.isArray(a.answers) && a.answers.every((x) => typeof x === 'string'))
    trace('__userInputReply', reply?.__error || wellFormed ? reply : { __malformed: reply })
    notify('item/completed', {
      threadId: THREAD_ID, turnId,
      item: { type: 'agentMessage', id: 'msg-q', text: reply?.__error ? 'refused' : 'answered', phase: null },
    })
  }

  if (scenario === 'dynamic-tool') {
    // The model calls a dynamic tool; the DAEMON executes it, which is what
    // keeps bridged connector tools inside the platform permission gate.
    const reply = await ask('item/tool/call', {
      threadId: THREAD_ID, turnId, callId: 'call-1', namespace: null,
      tool: 'zwrm__platform__sleep', arguments: { seconds: 1 },
    })
    trace('__toolReply', reply)
    notify('item/completed', {
      threadId: THREAD_ID, turnId,
      item: {
        type: 'dynamicToolCall', id: 'item-dyn', tool: 'zwrm__platform__sleep',
        arguments: { seconds: 1 }, success: reply?.success !== false,
        contentItems: reply?.contentItems || [],
      },
    })
  }

  if (scenario === 'unknown-tool') {
    const reply = await ask('item/tool/call', {
      threadId: THREAD_ID, turnId, callId: 'call-2', namespace: null,
      tool: 'zwrm__github__create_issue', arguments: {},
    })
    trace('__toolReply', reply)
  }

  if (scenario === 'todo') {
    // The plan tool: a todoList thread item is not a tool item and must land
    // as a todo.updated snapshot, not a transcript entry (#1424).
    notify('item/completed', {
      threadId: THREAD_ID, turnId,
      item: {
        type: 'todoList', id: 'item-todo',
        items: [{ text: 'read the code', completed: true }, { text: 'write tests', completed: false }],
      },
    })
  }

  if (scenario === 'interrupt' || scenario === 'steer-precondition') {
    // Never completes on its own: the turn stays live so the driver must
    // interrupt it, or (steer-precondition) so a second message genuinely
    // takes the steer path rather than opening a fresh turn.
    return
  }

  if (scenario === 'double-terminal') {
    // The both-carriers case emitResult's guard exists for: a turn that
    // errors AND then reports completion. Exactly one sdk.result may result.
    notify('error', {
      threadId: THREAD_ID, turnId, willRetry: false,
      error: { message: 'stream died', codexErrorInfo: 'responseStreamDisconnected', additionalDetails: null },
    })
    notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: turnId, items: [], status: 'failed', error: { message: 'stream died', codexErrorInfo: null, additionalDetails: null } },
    })
    return
  }

  if (scenario === 'will-retry') {
    // codex retrying the turn itself is NOT a result; emitting one here would
    // complete an autonomous run mid-flight.
    notify('error', {
      threadId: THREAD_ID, turnId, willRetry: true,
      error: { message: 'transient', codexErrorInfo: 'serverOverloaded', additionalDetails: null },
    })
    notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: turnId, items: [], status: 'completed', error: null },
    })
    return
  }

  notify('item/agentMessage/delta', { threadId: THREAD_ID, turnId, itemId: 'msg-1', delta: 'MARK' })
  notify('item/agentMessage/delta', { threadId: THREAD_ID, turnId, itemId: 'msg-1', delta: 'ER' })
  notify('item/completed', {
    threadId: THREAD_ID, turnId,
    item: { type: 'agentMessage', id: 'msg-1', text: 'MARKER', phase: null },
  })
  notify('thread/tokenUsage/updated', {
    threadId: THREAD_ID, turnId,
    tokenUsage: {
      total: { totalTokens: 30, inputTokens: 10, cachedInputTokens: 2, outputTokens: 20, reasoningOutputTokens: 0 },
      last: { totalTokens: 30, inputTokens: 10, cachedInputTokens: 2, outputTokens: 20, reasoningOutputTokens: 0 },
      modelContextWindow: 400000,
    },
  })

  if (scenario === 'turn-failed') {
    notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: turnId, items: [], status: 'failed', error: { message: 'model exploded', codexErrorInfo: 'internalServerError', additionalDetails: null } },
    })
    return
  }
  if (scenario === 'error-notification') {
    notify('error', {
      threadId: THREAD_ID, turnId, willRetry: false,
      error: { message: 'stream died', codexErrorInfo: 'responseStreamDisconnected', additionalDetails: null },
    })
    return
  }

  notify('turn/completed', {
    threadId: THREAD_ID,
    turn: { id: turnId, items: [], status: 'completed', error: null },
  })
}

let turnSeq = 0
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }

  // A reply to one of our server->client requests.
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = awaitingReply.get(msg.id)
    if (resolve) {
      awaitingReply.delete(msg.id)
      resolve(msg.error ? { __error: msg.error } : msg.result)
    }
    return
  }

  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { userAgent: 'fake/1.0', codexHome: '/tmp/fake' } })
      return
    case 'initialized':
      return
    case 'skills/extraRoots/set':
      trace('skills/extraRoots/set', msg.params)
      send({ id: msg.id, result: {} })
      return
    case 'thread/start':
    case 'thread/resume': {
      if (scenario === 'start-fails') {
        send({ id: msg.id, error: { code: -32000, message: '401 Unauthorized' } })
        return
      }
      // The rollout is gone but the app-server is healthy — the shape a lost
      // or un-rehydrated workspace volume produces. Resume must fail and a
      // fresh start must succeed.
      if (scenario === 'resume-fails' && msg.method === 'thread/resume') {
        trace(msg.method, msg.params)
        send({ id: msg.id, error: { code: -32602, message: 'thread not found' } })
        return
      }
      trace(msg.method, msg.params)
      send({
        id: msg.id,
        result: {
          thread: { id: THREAD_ID, status: { type: 'idle' }, turns: [] },
          model: msg.params?.model || 'gpt-5.6-sol',
          modelProvider: 'openai',
          cwd: msg.params?.cwd || '/home/agent',
          approvalPolicy: msg.params?.approvalPolicy || 'never',
          sandbox: { type: 'dangerFullAccess' },
          reasoningEffort: null,
        },
      })
      return
    }
    case 'turn/start': {
      turnSeq++
      const turnId = `${TURN_ID}-${turnSeq}`
      trace('turn/start', msg.params)
      // Hold the FIRST turn's response AND its turn/started back, so a test can
      // interrupt while that turn is still OPENING — the window where it has no
      // id to cancel and cancellation must be deferred to the notification.
      // Both are delayed because the driver also learns the id from the
      // response, which would otherwise close the window immediately.
      //
      // A second turn requested inside that window is held until turn 1 has
      // reported, preserving the real server's ordering: turns run serially on
      // a thread, so turn/started notifications arrive in request order. A fake
      // that let turn 2 report first would be testing against a server that
      // cannot exist.
      if (scenario === 'slow-open') {
        const delay = turnSeq === 1 ? 150 : 200
        setTimeout(() => {
          send({ id: msg.id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } })
          if (turnSeq === 1) {
            // Interrupted while opening: report it started, then stop. The
            // driver is expected to cancel it.
            notify('turn/started', {
              threadId: THREAD_ID, turn: { id: turnId, items: [], status: 'inProgress', error: null },
            })
          } else {
            runTurn(turnId)
          }
        }, delay)
        return
      }
      send({ id: msg.id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } })
      runTurn(turnId)
      return
    }
    case 'turn/steer': {
      trace('turn/steer', msg.params)
      if (scenario === 'steer-precondition') {
        send({ id: msg.id, error: { code: -32001, message: 'expected turn id does not match the active turn' } })
        return
      }
      send({ id: msg.id, result: {} })
      return
    }
    case 'turn/interrupt': {
      trace('turn/interrupt', msg.params)
      // The real app-server holds the turn on an unanswered server->client
      // request, so an interrupt issued while an approval is outstanding
      // cannot complete until that reply arrives. Modelling that is what
      // makes "cancel pending approvals FIRST" a testable claim rather than a
      // comment — reorder the driver and this hangs.
      while (awaitingReply.size > 0) await sleep(5)
      send({ id: msg.id, result: {} })
      await sleep(5)
      notify('turn/completed', {
        threadId: THREAD_ID,
        turn: { id: msg.params?.turnId, items: [], status: 'interrupted', error: null },
      })
      return
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
})
