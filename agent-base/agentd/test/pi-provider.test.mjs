import { strict as assert } from 'node:assert'
import test from 'node:test'

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { SettingsManager, shouldCompact } from '@earendil-works/pi-coding-agent'

import { COMPACT_AT_TOKENS, compactionReserves, keepCompactionReserves, providerForModel } from '../drivers/pi-provider.mjs'

// The real shape the platform seeds (#1142): providers keyed by name, each with
// its own model list.
const CATALOG = JSON.stringify({
  providers: {
    lyceum: {
      baseUrl: 'https://api.lyceum.technology/api/v2/external/serverless/',
      apiKey: '$LYCEUM_API_KEY',
      models: [
        { id: 'z-ai/glm-5.2' },
        { id: 'deepseek/deepseek-v4-pro' },
        { id: 'moonshotai/kimi-k2.7-code' },
      ],
    },
    nebius: {
      baseUrl: 'https://api.tokenfactory.nebius.com/v1/',
      apiKey: '$NEBIUS_API_KEY',
      models: [{ id: 'Qwen/Qwen3-235B-A22B-Instruct-2507' }, { id: 'openai/gpt-oss-120b' }],
    },
    // The agent-visible gateway-only vendor (#1340), in the zwrm- namespace
    // because a group named plain "openai" would merge with pi's BUILTIN
    // openai provider and inherit its whole model list. Note the trap this
    // fixture deliberately sets: nebius above serves openai/gpt-oss-120b
    // (author prefix, open weights), so attribution must go by exact id in a
    // group's model list, never by the slug's author prefix.
    'zwrm-openai': {
      baseUrl: 'https://cp.example.com/v1/openai/',
      apiKey: '$ZWRM_GATEWAY_TOKEN',
      models: [{ id: 'openai/gpt-5.6-sol' }, { id: 'openai/gpt-5.6-luna' }],
    },
    zwrm: {
      baseUrl: 'https://cp.example.com/v1/openai/',
      apiKey: '$ZWRM_GATEWAY_TOKEN',
      models: [{ id: 'zwrm/auto' }],
    },
  },
})

const reader = (body) => () => {
  if (body === null) throw new Error('ENOENT')
  return body
}

test('resolves a model to the provider that actually serves it', () => {
  assert.equal(providerForModel('/a', 'z-ai/glm-5.2', reader(CATALOG)), 'lyceum')
  assert.equal(providerForModel('/a', 'moonshotai/kimi-k2.7-code', reader(CATALOG)), 'lyceum')
  assert.equal(providerForModel('/a', 'Qwen/Qwen3-235B-A22B-Instruct-2507', reader(CATALOG)), 'nebius')
  assert.equal(providerForModel('/a', 'openai/gpt-oss-120b', reader(CATALOG)), 'nebius')
  assert.equal(providerForModel('/a', 'openai/gpt-5.6-luna', reader(CATALOG)), 'zwrm-openai')
  assert.equal(providerForModel('/a', 'zwrm/auto', reader(CATALOG)), 'zwrm')
})

// The regression this module exists for (#1149): a second vendor's model must
// NOT come back as the first provider. Pinning 'nebius' sent glm-5.2 to the
// Nebius endpoint, which answers a bodyless 404 — the session ended
// stop_reason=error with zero tokens and an empty result, and nothing named the
// cause.
test('a second-vendor model never resolves to the first provider', () => {
  const p = providerForModel('/a', 'z-ai/glm-5.2', reader(CATALOG))
  assert.notEqual(p, 'nebius')
  assert.equal(p, 'lyceum')
})

// null means "caller keeps its fallback", never a wrong guess.
test('returns null rather than guessing', () => {
  assert.equal(providerForModel('/a', 'unlisted/model', reader(CATALOG)), null)
  assert.equal(providerForModel('/a', '', reader(CATALOG)), null)
  assert.equal(providerForModel('/a', undefined, reader(CATALOG)), null)
})

test('a missing or malformed catalog degrades to null, not a throw', () => {
  assert.equal(providerForModel('/a', 'z-ai/glm-5.2', reader(null)), null)
  assert.equal(providerForModel('/a', 'z-ai/glm-5.2', reader('not json')), null)
  assert.equal(providerForModel('/a', 'z-ai/glm-5.2', reader('{}')), null)
  assert.equal(providerForModel('/a', 'z-ai/glm-5.2', reader('{"providers":null}')), null)
  assert.equal(
    providerForModel('/a', 'z-ai/glm-5.2', reader('{"providers":{"lyceum":{}}}')),
    null,
    'a provider with no models array must be skipped, not throw',
  )
})

test('reads models.json from the given agent dir', () => {
  let seen
  providerForModel('/home/agent/.pi/agent', 'z-ai/glm-5.2', (p) => {
    seen = p
    return CATALOG
  })
  assert.equal(seen, '/home/agent/.pi/agent/models.json')
})

// An array-shaped providers value is typeof 'object': without an Array.isArray
// guard Object.entries yields index keys and the function returns "0" as a
// provider name, which exists in no runtime — an opaque failure instead of the
// null the caller knows how to refuse on.
test('an array-shaped providers value yields null, not a numeric index', () => {
  const arrayShaped = JSON.stringify({ providers: [{ models: [{ id: 'z-ai/glm-5.2' }] }] })
  assert.equal(providerForModel('/a', 'z-ai/glm-5.2', reader(arrayShaped)), null)
})

// pi's own loader strips comments before parsing, so a models.json carrying
// them is valid input as far as pi is concerned. If this reader disagreed, an
// edited-but-valid catalog would be unattributable and every session refused.
test('tolerates comments, like the loader pi uses', () => {
  const commented = `{
    // the platform writes this file on every boot
    "providers": {
      "lyceum": {
        /* block comment */
        "baseUrl": "https://api.lyceum.technology/api/v2/external/serverless/",
        "models": [{ "id": "z-ai/glm-5.2" }]
      }
    }
  }`
  assert.equal(providerForModel('/a', 'z-ai/glm-5.2', reader(commented)), 'lyceum')
})

// A URL inside a string must not be mistaken for a line comment by the
// stripper — truncating there would corrupt otherwise-valid JSON.
test('a // inside a string literal is not treated as a comment', () => {
  const withURL = JSON.stringify({
    providers: { nebius: { baseUrl: 'https://api.tokenfactory.nebius.com/v1/', models: [{ id: 'a/b' }] } },
  })
  assert.equal(providerForModel('/a', 'a/b', reader(withURL)), 'nebius')
})

// Duplicates cannot occur in a platform-generated catalog (state.PiModels
// enforces global uniqueness), but a hand-edited file could contain them. Pin
// the outcome as deterministic rather than insertion-order-dependent: the Go
// side emits the map via json.MarshalIndent, which sorts keys.
test('duplicate ids resolve deterministically to the first key', () => {
  const dup = JSON.stringify({
    providers: {
      lyceum: { models: [{ id: 'shared/model' }] },
      nebius: { models: [{ id: 'shared/model' }] },
    },
  })
  assert.equal(providerForModel('/a', 'shared/model', reader(dup)), 'lyceum')
})

// The models.json groups the platform writes (state.PiCatalogGroupName),
// with real catalog windows.
const WINDOWS = JSON.stringify({
  providers: {
    'zwrm-azure_openai': {
      models: [
        { id: 'openai/gpt-6.1-sol', contextWindow: 1_050_000 },
        { id: 'openai/gpt-6-luna', contextWindow: 1_050_000 },
      ],
    },
    'zwrm-bedrock': { models: [{ id: 'anthropic/claude-opus-5-5', contextWindow: 1_000_000 }] },
    lyceum: {
      models: [
        { id: 'z-ai/glm-5.2', contextWindow: 262_144 },
        { id: 'moonshotai/kimi-k2.7-code', contextWindow: 128_000 },
        { id: 'no-window' },
        { id: 'float-window', contextWindow: 1_050_000.5 },
        { id: 'negative-window', contextWindow: -1 },
        { id: 'string-window', contextWindow: '1050000' },
      ],
    },
    nebius: { models: 'not a list' },
    zwrm: { models: [{ id: 'zwrm/auto', contextWindow: 'large' }, null] },
  },
}).replace('"zwrm-bedrock":', '// pi\'s loader allows comments\n"zwrm-bedrock":')

const SOL = { provider: 'zwrm-azure_openai', id: 'openai/gpt-6.1-sol', contextWindow: 1_050_000 }
const OPUS = { provider: 'zwrm-bedrock', id: 'anthropic/claude-opus-5-5', contextWindow: 1_000_000 }
const GLM = { provider: 'lyceum', id: 'z-ai/glm-5.2', contextWindow: 262_144 }

test('large-window models get a reserve that compacts them at COMPACT_AT_TOKENS', () => {
  assert.equal(COMPACT_AT_TOKENS, 256_000)
  assert.deepEqual(compactionReserves('/a', reader(WINDOWS)), {
    'zwrm-azure_openai/openai/gpt-6.1-sol': 794_000,
    'zwrm-azure_openai/openai/gpt-6-luna': 794_000,
    'zwrm-bedrock/anthropic/claude-opus-5-5': 744_000,
  })
})

test('an unreadable catalog leaves pi\'s own compaction alone', () => {
  for (const body of [null, 'not json', '{}', '{"providers":[]}', '{"providers":{"x":{"models":[{"id":"m"}]}}}']) {
    assert.deepEqual(compactionReserves('/a', reader(body)), {})
  }
})

// Against pi's own SettingsManager and threshold: the reserves reach the
// check pi runs before each request, and nothing that rebuilds pi's
// settings from the files drops them.
test('pi compacts the session at COMPACT_AT_TOKENS, whatever rebuilds its settings', async () => {
  const sm = SettingsManager.inMemory({ compaction: { keepRecentTokens: 30_000 } })
  keepCompactionReserves(sm, compactionReserves('/a', reader(WINDOWS)))
  const compactsAt = (model) => model.contextWindow - sm.getCompactionSettings(model).reserveTokens
  const check = (when) => {
    for (const model of [SOL, OPUS]) {
      const settings = sm.getCompactionSettings(model)
      assert.equal(shouldCompact(COMPACT_AT_TOKENS, model.contextWindow, settings), false, `${model.id} ${when}`)
      assert.equal(shouldCompact(COMPACT_AT_TOKENS + 1, model.contextWindow, settings), true, `${model.id} ${when}`)
      assert.equal(settings.keepRecentTokens, 30_000, `the user's other settings stay ${when}`)
    }
    // pi's default already compacts a 262k window below 256k.
    assert.ok(compactsAt(GLM) < COMPACT_AT_TOKENS, when)
  }
  check('at start')
  await sm.reload()
  check('after a reload')
  sm.setDefaultThinkingLevel('high')
  check('after a save')
  sm.setProjectTrusted(false)
  check('after a trust change')
  await sm.reload()
  check('after another reload')
})

test('a larger reserve of the user\'s own still wins', () => {
  const sm = SettingsManager.inMemory({
    compaction: { modelOverrides: { 'zwrm-azure_openai/openai/gpt-6.1-sol': { reserveTokens: 900_000 } } },
  })
  keepCompactionReserves(sm, compactionReserves('/a', reader(WINDOWS)))
  assert.equal(sm.getCompactionReserveTokens(SOL), 900_000)
  assert.equal(sm.getCompactionReserveTokens(OPUS), 744_000)
  assert.equal(sm.getCompactionReserveTokens(undefined), 16_384)
})

// Source-text pin: createAgentSession builds a settings manager of its own
// unless given one, which would compact near the window again.
test('the pi driver gives the session the settings manager that carries the reserves', async () => {
  const src = await readFile(fileURLToPath(new URL('../drivers/pi.mjs', import.meta.url)), 'utf8')
  assert.match(src, /keepCompactionReserves\(settingsManager, compactionReserves\(agentDir\)\)/)
  const create = src.slice(src.indexOf('await createAgentSession({'))
  assert.match(create.slice(0, create.indexOf('\n    })')), /\n\s+settingsManager,\n/)
})
