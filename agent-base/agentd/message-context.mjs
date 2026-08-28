// Cross-deploy contract: dashboard/src/lib/agentChatModel.ts strips this exact
// frozen tag from durable user messages. Change both ends only in one rollout.
export const ATTACHED_CONTEXT_MARKER = '<zwrm-attached-context>'
export const ATTACHED_CONTEXT_END = ATTACHED_CONTEXT_MARKER.replace('<', '</')

// The control plane's limits are authoritative. These daemon-side defense-in-
// depth caps must stay greater than or equal to the corresponding CP caps.
const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024

function cleanAttachment(value) {
  if (!value || typeof value !== 'object') return null
  const path = typeof value.path === 'string' ? value.path.trim() : ''
  const size = Number(value.size)
  if (!path || path.startsWith('/') || path.split('/').includes('..')) return null
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) return null
  return {
    id: typeof value.id === 'string' ? value.id.slice(0, 128) : '',
    path,
    name: typeof value.name === 'string' && value.name ? value.name : path.split('/').at(-1),
    mime_type: typeof value.mime_type === 'string' ? value.mime_type : 'text/plain; charset=utf-8',
    size,
    source: value.source === 'upload' ? 'upload' : 'workspace',
  }
}

// The control plane has already read and validated these references against
// this session's workspace. Agentd keeps a second, cheap shape/path check so
// a direct daemon caller cannot smuggle arbitrary paths into the prompt.
export function prepareMessage(text, requestedAttachments) {
  if (typeof text !== 'string') throw new Error('missing text')
  if (requestedAttachments != null && !Array.isArray(requestedAttachments)) throw new Error('attachments must be an array')
  if ((requestedAttachments?.length ?? 0) > MAX_ATTACHMENTS) throw new Error('too many attachments')
  const attachments = (requestedAttachments || []).map(cleanAttachment)
  if (attachments.some((attachment) => !attachment)) throw new Error('invalid attachment')
  if (text.trim() === '' && attachments.length === 0) throw new Error('missing text')

  const visibleText = text.trim()
  if (attachments.length === 0) return { prompt: visibleText, text: visibleText, attachments }
  const references = attachments.map((attachment) =>
    `- ${JSON.stringify(attachment.path)} (${attachment.mime_type}, ${attachment.size} bytes)`).join('\n')
  return {
    prompt: `${visibleText}${visibleText ? '\n\n' : ''}${ATTACHED_CONTEXT_MARKER}\n` +
      'The user attached these validated files from the current workspace. Read them with your file tools before relying on their contents:\n' +
      `${references}\n${ATTACHED_CONTEXT_END}`,
    text: visibleText,
    attachments,
  }
}
