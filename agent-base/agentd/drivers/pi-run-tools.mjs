// Platform run tools for the pi harness (#1065): native pi ToolDefinitions
// with the same semantics (and model-facing text) as the claude driver's
// in-process MCP `platform` server (#803) — sleep/sleep_until and
// wait_for_task (#1911) block the turn on a park promise, the VM
// idle-suspends, and the control plane resolves it via the existing
// POST /parks/{id}/resolve endpoint. Validation and the park request come
// from the shared run-tools module (#1493); this file only renders pi's
// schema and result envelope. Which tools a session gets is the shared
// spec gate (platformToolNames): the sleep tools on unattended runs only (a
// human is on an interactive session's stream), wait_for_task on either
// when spec.task_waits.
import {
  SLEEP,
  SLEEP_UNTIL,
  WAIT_FOR_TASK,
  SLEEP_DESCRIPTION,
  SLEEP_UNTIL_DESCRIPTION,
  WAIT_FOR_TASK_DESCRIPTION,
  sleepInputSchema,
  sleepUntilInputSchema,
  waitForTaskInputSchema,
  runSleep,
  runSleepUntil,
  runWaitForTask,
  mapOutcome,
  platformToolNames,
} from './run-tools.mjs'

// piOutcome maps a run-tools outcome onto pi's envelope: a rejection throws
// (pi renders a failed tool call); text and park content become tool
// content. resolvePark always resolves with one text block.
async function piOutcome(pending) {
  return mapOutcome(await pending, {
    error: (o) => { throw new Error(o.error) },
    text: (text) => ({ content: [{ type: 'text', text }], details: null }),
    park: (result) => ({ content: result.content, details: null }),
  })
}

// buildRunTools renders the platform tools spec gives this session.
export function buildRunTools(s, h, spec) {
  const all = {
    [SLEEP]: {
      name: SLEEP,
      label: 'platform: sleep',
      description: SLEEP_DESCRIPTION(h.MAX_SLEEP_SECONDS),
      parameters: sleepInputSchema(h.MAX_SLEEP_SECONDS),
      execute: (_id, args) => piOutcome(runSleep(s, h, args)),
    },
    [SLEEP_UNTIL]: {
      name: SLEEP_UNTIL,
      label: 'platform: sleep_until',
      description: SLEEP_UNTIL_DESCRIPTION(h.MAX_SLEEP_SECONDS),
      parameters: sleepUntilInputSchema(),
      execute: (_id, args) => piOutcome(runSleepUntil(s, h, args)),
    },
    [WAIT_FOR_TASK]: {
      name: WAIT_FOR_TASK,
      label: 'platform: wait_for_task',
      description: WAIT_FOR_TASK_DESCRIPTION(h.MAX_SLEEP_SECONDS),
      parameters: waitForTaskInputSchema(h.MAX_SLEEP_SECONDS),
      execute: (_id, args) => piOutcome(runWaitForTask(s, h, args)),
    },
  }
  return platformToolNames(spec).map((name) => all[name])
}
