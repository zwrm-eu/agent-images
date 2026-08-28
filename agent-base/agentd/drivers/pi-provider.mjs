// Provider resolution for the pi driver (#1149).
//
// The pi catalog spans multiple vendors since #1142, and ~/.pi/agent/models.json
// names the owner of every model id. The driver must therefore derive the
// provider from the MODEL rather than pinning one.
//
// Why this is its own module: it must be unit-testable, and importing the
// driver pulls in @earendil-works/pi-coding-agent, which is only installed
// inside the agent image. Same split as pi-translate.mjs.
import { readFileSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'

// stripJsonComments removes // and /* */ comments outside string literals.
//
// pi's own loader (ModelConfig.load) does this before parsing, so models.json
// with comments is valid input as far as pi is concerned. Without matching it
// here the two disagree about whether the file parses at all — and a
// disagreement means we cannot attribute the model, which is now a hard failure
// (see providerForModel). Hand-rolled rather than a dependency because the
// image installs production deps only and this is a dozen lines.
//
// String-aware, including escapes: a URL like "https://x/y" inside a value must
// not be mistaken for a line comment. Unterminated block comments are dropped,
// matching the permissive behaviour of the parsers this mirrors.
function stripJsonComments(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++ // land on '/', loop's i++ steps past it
      continue
    }
    out += c
  }
  return out
}

// providerForModel returns the provider name serving modelId, or null when the
// catalog cannot attribute it.
//
// null means "this VM cannot tell you who owns this model", and the caller MUST
// treat that as a hard failure rather than substituting a default. Falling back
// to a fixed provider is what #1149 was: pi does not reject a model that is
// absent from the named provider — resolveCliModel calls buildFallbackModel,
// which clones a model from that provider and overwrites its id, so the request
// is POSTed to the WRONG vendor and comes back a bodyless 404. The session then
// ends stop_reason=error with zero tokens, which the control plane records as
// subtype=success with an empty result. No exception is thrown anywhere, so a
// `if (!resolved.model)` guard cannot catch it and the user just sees a chat
// that returns nothing.
//
// Reads the same file pi loads, with the same comment tolerance, so the two
// cannot disagree about ownership. (The platform never sets PI_AGENT_DIR; the
// caller passes the same directory it uses for the resume jail.)
//
// Ties: first match in Object.entries order. The platform's catalog cannot
// contain duplicate ids — state.PiModels enforces global uniqueness via
// TestPiModelsUnique precisely so this question stays hypothetical — and
// build/pi_models.go emits the map through json.MarshalIndent, which sorts
// keys, so the outcome is at least deterministic (alphabetically first wins)
// rather than dependent on insertion order.
export function providerForModel(agentDir, modelId, readFile = readFileSync) {
  if (!modelId) return null
  let doc
  try {
    doc = JSON.parse(stripJsonComments(readFile(pathResolve(agentDir, 'models.json'), 'utf8')))
  } catch {
    return null
  }
  const providers = doc?.providers
  // Arrays are typeof 'object': an array-shaped catalog would otherwise yield a
  // numeric index ("0") as the provider name, which exists in no runtime.
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return null
  for (const [name, provider] of Object.entries(providers)) {
    const models = provider?.models
    if (!Array.isArray(models)) continue
    if (models.some((m) => m?.id === modelId)) return name
  }
  return null
}
