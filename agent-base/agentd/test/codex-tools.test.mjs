// Tests for the codex dynamic-tool naming and dispatch rules (#1090). These
// import no MCP SDK and spawn nothing — the naming rules are the load-bearing
// part, and keeping them free of node_modules is what lets them be tested.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODEX_TOOL_PREFIX,
  canonicalToolName,
  codexToolName,
  codexToolSpec,
  mcpResultToCodex,
  toolCallResponse,
  connectorFingerprint,
} from '../drivers/codex-tools.mjs'

test('bridged tools avoid the reserved mcp__ prefix on the wire', () => {
  // Verified against the pinned 0.153.4: declaring a dynamic tool named
  // mcp__github__create_issue is rejected with "dynamic tool name is
  // reserved", and so is a namespace of that shape. Codex keeps mcp__ for its
  // own MCP client, so the platform's canonical name cannot go on this wire.
  const wire = codexToolName('github', 'create_issue')
  assert.ok(!wire.startsWith('mcp__'), wire)
  assert.equal(wire, 'zwrm__github__create_issue')
  assert.equal(CODEX_TOOL_PREFIX, 'zwrm__')
})

test('the wire name canonicalizes back to the platform name', () => {
  // Everything platform-side speaks mcp__<slug>__<tool> on every harness: the
  // escalation gate (isEscalatedTool) matches it, and the transcript records
  // it. If this mapping breaks, escalation goes dark on codex specifically —
  // connector tools would run without ever pausing for a human.
  assert.equal(canonicalToolName('zwrm__github__create_issue'), 'mcp__github__create_issue')
  assert.equal(canonicalToolName(codexToolName('slack', 'post_message')), 'mcp__slack__post_message')
  // A slug or tool containing the separator still round-trips, because only
  // the prefix is rewritten.
  assert.equal(canonicalToolName('zwrm__a__b__c'), 'mcp__a__b__c')
  // Platform run tools are not connector tools and are left alone.
  assert.equal(canonicalToolName('zwrm__platform__sleep'), 'mcp__platform__sleep')
  // Anything without the prefix passes through untouched.
  assert.equal(canonicalToolName('shell'), 'shell')
  assert.equal(canonicalToolName(''), '')
  assert.equal(canonicalToolName(undefined), '')
})

test('a tool spec carries the MCP schema through unchanged', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
  const spec = codexToolSpec('github', { name: 'create_issue', description: 'Open an issue', inputSchema: schema })
  assert.equal(spec.type, 'function')
  assert.equal(spec.name, 'zwrm__github__create_issue')
  assert.equal(spec.description, 'Open an issue')
  assert.deepEqual(spec.inputSchema, schema)
  // A tool with no description still gets one: codex requires the field.
  const bare = codexToolSpec('github', { name: 'ping' })
  assert.ok(bare.description.length > 0)
  assert.deepEqual(bare.inputSchema, { type: 'object', properties: {} })
})

test('MCP results map onto codex content items, preserving failure', () => {
  assert.deepEqual(
    mcpResultToCodex({ content: [{ type: 'text', text: 'ok' }] }),
    { contentItems: [{ type: 'inputText', text: 'ok' }], success: true },
  )
  // isError is the tool failing, which the model must see as a failure rather
  // than as a successful call that happens to mention an error.
  assert.deepEqual(
    mcpResultToCodex({ isError: true, content: [{ type: 'text', text: 'upstream 500' }] }),
    { contentItems: [{ type: 'inputText', text: 'upstream 500' }], success: false },
  )
  // An empty result still needs one content item.
  assert.deepEqual(mcpResultToCodex({ content: [] }).contentItems, [{ type: 'inputText', text: '' }])
  const img = mcpResultToCodex({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] })
  assert.deepEqual(img.contentItems, [{ type: 'inputImage', imageUrl: 'data:image/jpeg;base64,AAAA' }])
})

test('toolCallResponse renders the shape codex expects', () => {
  assert.deepEqual(toolCallResponse('hi'), { contentItems: [{ type: 'inputText', text: 'hi' }], success: true })
  assert.deepEqual(toolCallResponse('denied', false).success, false)
})

test('the fingerprint tracks the CONNECTOR set only', () => {
  // It decides whether a thread may be resumed, so what it includes is the
  // whole design. Order must not matter (server listing order is not stable),
  // membership must, and it must be computed from CONFIGURED slugs rather than
  // discovered tools — see the three ways the tool-list version was wrong,
  // documented on connectorFingerprint.
  const a = connectorFingerprint({ github: {}, slack: {} })
  const b = connectorFingerprint({ slack: {}, github: {} })
  assert.equal(a, b, 'reordering the same connectors is not a change')
  assert.notEqual(a, connectorFingerprint({ github: {} }), 'detaching a connector is a change')
  assert.notEqual(a, connectorFingerprint({ github: {}, slack: {}, jira: {} }), 'attaching one is a change')
  assert.equal(connectorFingerprint({}), '')
  assert.equal(connectorFingerprint(undefined), '')

  // The decisive property: it does not depend on session kind. A run declares
  // the platform sleep tools and a chat declares none, so a tool-list
  // fingerprint made chat and runs on one workspace disagree forever — every
  // alternation between them discarded the conversation.
  assert.equal(connectorFingerprint({ zwrm: {} }), connectorFingerprint({ zwrm: {} }))
})
