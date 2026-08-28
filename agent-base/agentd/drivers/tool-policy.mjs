// Daemon-enforced tool policies (#1330). A policy restricts what a session's
// tools may do REGARDLESS of permission mode — the platform assistant runs
// with spec.tool_policy = 'platform', which confines it to driving the zwrm
// platform: MCP tools and single `zwrm` CLI invocations only, with
// destructive subcommands forced through a permission prompt even in
// bypassPermissions (or refused outright on unattended runs, which have
// nobody to answer a prompt).
//
// This is an enforcement layer, not a suggestion to the model: the system
// prompt (agentsession/assistant.go, AssistantBasePrompt — keep the two in
// step) describes the same rules, but the verdict here is what actually
// gates the call. Deny-by-default on purpose — an SDK upgrade that adds a new
// native tool must not silently widen the assistant's reach.
//
// The control plane refuses to start a policy-carrying session on a daemon
// that lacks the 'tool-policy' /healthz cap, so an old build can never run a
// policied session unrestricted.

// Shell metacharacters that would let one approved `zwrm` invocation smuggle
// a second command (`;`, `&&`, `|`, substitution, redirection) or expand into
// argv the member never saw (globs). Quotes stay legal — `zwrm secrets set
// KEY="two words"` is a normal command — which is safe because the string is
// still executed as ONE zwrm argv when none of these can chain, substitute,
// or expand; the token checks below strip quotes before comparing, so
// quoting cannot DISGUISE a token either.
const SHELL_META = /[;&|<>`$(){}\n\r\\*?[\]]/

// Subcommand words that must be confirmed by the member before running, in
// any permission mode. `restore` is here because it overwrites live data
// (postgres backup restore, volume snapshot restore). Matched against EVERY
// token after `zwrm` — quote-stripped, dash-stripped, case-folded — because
// the zwrm CLI nests three deep (`zwrm postgres backup delete <id>`) and
// flag values shift positions (`zwrm --org acme destroy app`); a positional
// window provably missed both. A resource merely NAMED "delete-me" does not
// trip it (whole-token match only), and over-matching costs a prompt, never
// a block.
const DESTRUCTIVE_WORDS = new Set(['destroy', 'delete', 'remove', 'rm', 'unset', 'restore'])

// bareToken strips the characters the shell would strip or that only decorate
// a token (quotes, leading dashes), so `"destroy"`, `des'troy'` and
// `--delete` all compare as the word the executed argv will actually carry.
function bareToken(token) {
  return token.replace(/["']/g, '').replace(/^-+/, '').toLowerCase()
}

const POLICIES = {
  platform: evaluatePlatform,
}

// TOOL_POLICIES is derived from the dispatch table so the create-time
// validation (server.mjs) and the evaluator can never disagree about which
// policies exist.
export const TOOL_POLICIES = new Set(Object.keys(POLICIES))

// evaluateToolPolicy returns the policy's verdict on one tool call:
//   { allow: true }            — proceed to the normal permission-mode flow
//   { block: true, reason }    — deny outright, reason shown to the model
//   { confirm: true, reason }  — allowed, but a permission prompt is
//                                mandatory even in bypassPermissions
// context.interactive says whether anyone can ANSWER a prompt: on an
// unattended run a confirm verdict downgrades to a block with an
// explanation, because a prompt nobody can resolve just wedges the turn.
// An unknown policy blocks everything: failing open on a typo would run the
// assistant unrestricted, the exact outcome the cap gate exists to prevent.
export function evaluateToolPolicy(policy, toolName, input, context = {}) {
  const evaluate = POLICIES[policy]
  if (!evaluate) {
    return { block: true, reason: `unknown tool policy '${policy}'` }
  }
  const verdict = evaluate(toolName, input)
  if (verdict.confirm && context.interactive === false) {
    return {
      block: true,
      reason:
        `${verdict.reason} — unavailable in unattended runs; ` +
        'ask the member to run it from the assistant chat',
    }
  }
  return verdict
}

function evaluatePlatform(toolName, input) {
  // Bridged platform tools (connectors + the zwrm session server) are the
  // assistant's intended surface; the gateway scopes what they reach.
  if (toolName.startsWith('mcp__')) return { allow: true }
  // The platform's own turn-parking tools (unattended runs).
  if (toolName === 'sleep' || toolName === 'sleep_until') return { allow: true }
  if (toolName === 'bash') return evaluateBash(input)
  return {
    block: true,
    reason:
      `the '${toolName}' tool is not available under the platform policy: ` +
      'this session drives the zwrm platform (single `zwrm ...` bash commands and platform tools only)',
  }
}

function evaluateBash(input) {
  const command = typeof input?.command === 'string' ? input.command.trim() : ''
  if (!command) {
    return { block: true, reason: 'the platform policy requires a single `zwrm ...` command' }
  }
  if (SHELL_META.test(command)) {
    return {
      block: true,
      reason:
        'the platform policy allows one plain `zwrm ...` command per call — ' +
        'no pipes, chaining, substitution, redirection, or globs',
    }
  }
  const tokens = command.split(/\s+/)
  // The program name must be the RAW token `zwrm` — a quoted spelling would
  // execute identically but is nothing a well-behaved model emits, so it is
  // refused rather than normalized (fail closed in the strict direction).
  if (tokens[0] !== 'zwrm') {
    return {
      block: true,
      reason: `'${tokens[0]}' is not available under the platform policy: only the zwrm CLI can be run`,
    }
  }
  for (const token of tokens.slice(1)) {
    const word = bareToken(token)
    if (DESTRUCTIVE_WORDS.has(word)) {
      return { confirm: true, reason: `'${word}' is destructive and needs the member's approval` }
    }
  }
  return { allow: true }
}
