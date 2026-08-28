function contentBlocks(payload) {
  return Array.isArray(payload?.message?.content) ? payload.message.content : []
}

function operation(kind, fallback = 'modified') {
  const normalized = String(kind || '').toLowerCase()
  if (normalized === 'add' || normalized === 'added' || normalized === 'create' || normalized === 'created') return 'created'
  if (normalized === 'delete' || normalized === 'deleted' || normalized === 'remove' || normalized === 'removed') return 'deleted'
  return fallback
}

function filesForTool(block) {
  const name = String(block?.name || '').toLowerCase()
  const input = block?.input && typeof block.input === 'object' ? block.input : {}
  if (name === 'apply_patch' && Array.isArray(input.changes)) {
    return input.changes
      .filter((change) => typeof change?.path === 'string' && change.path)
      .map((change) => ({ path: change.path, operation: operation(change.kind) }))
  }
  const path = input.file_path ?? input.path ?? input.notebook_path
  const tools = new Map([
    // A generic write cannot tell create from overwrite. Only provider-native
    // apply_patch add metadata is strong enough to claim "created".
    ['write', 'written'], ['write_file', 'written'],
    ['edit', 'modified'], ['edit_file', 'modified'], ['multiedit', 'modified'],
    ['notebookedit', 'modified'], ['notebook_edit', 'modified'],
  ])
  if (!tools.has(name) || typeof path !== 'string' || !path) return []
  return [{ path, operation: tools.get(name) }]
}

// Derives changed-file summaries from provider-native tool_use/tool_result
// pairs inside agentd. The dashboard consumes only turn.files_changed; it
// never guesses by scraping arbitrary tool output.
export class ChangedFileTracker {
  constructor() {
    this.pending = new Map()
  }

  reset() {
    this.pending.clear()
  }

  observe(type, payload) {
    if (type === 'sdk.assistant') {
      for (const block of contentBlocks(payload)) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue
        const files = filesForTool(block)
        if (files.length > 0) this.pending.set(block.id, files)
      }
      return []
    }
    if (type !== 'sdk.user') return []
    const changed = []
    for (const block of contentBlocks(payload)) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const files = this.pending.get(block.tool_use_id)
      this.pending.delete(block.tool_use_id)
      if (!block.is_error && files) changed.push(...files)
    }
    return [...new Map(changed.map((file) => [file.path, file])).values()]
  }
}
