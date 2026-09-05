// Platform run tools for the pi harness (#1065): native pi ToolDefinitions
// with the same semantics (and model-facing text) as the claude driver's
// in-process MCP `platform` server (#803) — sleep/sleep_until block the turn
// on a park promise, the VM idle-suspends, and the park-wake sweep resolves
// via the existing POST /parks/{id}/resolve endpoint. Validation and the park
// request come from the shared run-tools module (#1493); this file only
// renders pi's schema and result envelope. Unattended runs only; interactive
// sessions get none (a human is on the stream).
import { SLEEP_DESCRIPTION, SLEEP_UNTIL_DESCRIPTION, sleepInputSchema, sleepUntilInputSchema, runSleep, runSleepUntil, mapOutcome } from './run-tools.mjs'

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

export function buildRunTools(s, h) {
  return [
    {
      name: 'sleep',
      label: 'platform: sleep',
      description: SLEEP_DESCRIPTION(h.MAX_SLEEP_SECONDS),
      parameters: sleepInputSchema(h.MAX_SLEEP_SECONDS),
      execute: (_id, args) => piOutcome(runSleep(s, h, args)),
    },
    {
      name: 'sleep_until',
      label: 'platform: sleep_until',
      description: SLEEP_UNTIL_DESCRIPTION(h.MAX_SLEEP_SECONDS),
      parameters: sleepUntilInputSchema(),
      execute: (_id, args) => piOutcome(runSleepUntil(s, h, args)),
    },
  ]
}
