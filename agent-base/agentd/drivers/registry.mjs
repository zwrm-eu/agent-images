// The ONE table of harnesses this daemon build can host (#1160).
//
// Everything harness-shaped derives from DRIVERS: the set of accepted
// `spec.harness` values, the harness capabilities advertised on /healthz, the
// construct dispatch, and the per-harness permission-mode policy enforced at
// session create and on the pre-seed stub. It exists because those used to be
// hand-synced lists, and they drifted: the seed-gate's deferred construction
// still branched pi-or-claude after #1088 added codex, so every codex session
// on a fresh workspace silently ran the CLAUDE harness and surfaced to users
// as an OpenAI model id rejected by Anthropic with 404 model_not_found.
// Deriving from one table makes an advertised-but-undispatched harness
// impossible by construction. Adding a harness is ONE entry here.
import { createClaudeDriver } from './claude.mjs'
import { createPiDriver, SUPPORTED_PERMISSION_MODES as PI_MODES } from './pi.mjs'
import { createCodexDriver, SUPPORTED_PERMISSION_MODES as CODEX_MODES } from './codex.mjs'
import { createOpenCodeDriver, SUPPORTED_PERMISSION_MODES as OPENCODE_MODES } from './opencode.mjs'

// modes: the permission modes the harness can host, owned and exported by the
// driver module itself so this table cannot disagree with what construction
// enforces. null = every platform mode (claude, the harness that has always
// accepted them all).
export const DRIVERS = {
  claude: { construct: createClaudeDriver, modes: null },
  pi: { construct: createPiDriver, modes: PI_MODES },
  codex: { construct: createCodexDriver, modes: CODEX_MODES },
  opencode: { construct: createOpenCodeDriver, modes: OPENCODE_MODES },
}

export const HARNESSES = new Set(Object.keys(DRIVERS))

// The harness capabilities for /healthz caps. claude has none: every daemon
// build has always hosted it, so state.HarnessDaemonCap returns "" and the
// control plane never gates on it. Every other harness advertises a cap named
// after itself — the CP side (state.harnessFacts DaemonCap) relies on that.
export const HARNESS_CAPS = Object.keys(DRIVERS).filter((h) => h !== 'claude')

// unsupportedPermissionMode builds the same client-facing 400 the drivers
// throw, for the callers that must reject a mode BEFORE construction runs
// (session create, the pre-seed stub). Accepting there and rejecting in the
// driver turns a clean 400 into an asynchronous session kill.
export function unsupportedPermissionMode(harness, mode) {
  const list = [...DRIVERS[harness].modes].map((m) => `'${m}'`).join(' and ')
  const e = new Error(`the ${harness} harness supports permission modes ${list}, not '${mode}'`)
  e.status = 400
  return e
}
