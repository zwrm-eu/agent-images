// Cross-deploy contract: dashboard/src/lib/agentChatModel.ts strips this exact
// frozen tag from durable user messages. Change both ends only in one rollout.
export const ATTACHED_CONTEXT_MARKER = '<zwrm-attached-context>'
export const ATTACHED_CONTEXT_END = ATTACHED_CONTEXT_MARKER.replace('<', '</')

// The control plane's limits are authoritative. These daemon-side defense-in-
// depth caps must stay greater than or equal to the corresponding CP caps.
// Daemons before #1666 allowed 8 files of 2 MiB each; the control plane sends
// more than that only to a daemon that advertises the 'bulk-attachments' cap.
// Any file the workspace upload API accepts (MAX_FILE_BYTES) can be attached.
export const MAX_ATTACHMENTS = 100
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

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
const MAX_AUTHOR_FIELD = 256

// cleanAuthor bounds the member identity the control plane attributes a
// message or decision to ({id, name?, email?, image?}, #1784). Null when
// there is none or it is malformed, so a direct daemon caller cannot smuggle
// arbitrary shapes into the durable timeline.
export function cleanAuthor(value) {
  if (!value || typeof value !== 'object') return null
  const field = (name) => (typeof value[name] === 'string' ? value[name].trim().slice(0, MAX_AUTHOR_FIELD) : '')
  const id = field('id')
  if (!id) return null
  const author = { id }
  for (const name of ['name', 'email', 'image']) {
    const cleaned = field(name)
    if (cleaned) author[name] = cleaned
  }
  return author
}

// speakerLine leads a shared chat's prompt with who is talking, in the
// "[From: Name <email>]" form the control plane's SharedChatPrompt tells the
// model to expect. Never part of the visible message text.
export function speakerLine(author) {
  if (!author) return ''
  // Line breaks, invisible characters and brackets can't break out of the
  // header or start another one.
  const name = (author.name || author.email || author.id).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\[\]［］]/gu, ' ')
  const email = author.email && author.email !== name
    ? ` <${author.email.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>\[\]［］]/gu, ' ')}>`
    : ''
  return `[From: ${name}${email}]`
}

// escapeSpeakerLines keeps a shared chat's message text from posing as the
// platform: every "[From:" in it is escaped, wherever it stands (a quote,
// bold, after an invisible character) and however it is spaced or bracketed,
// so the only header the model reads as a speaker is the one speakerLine
// adds.
export function escapeSpeakerLines(text) {
  return text.replace(/([\[［])([\s\p{Cf}]*from[\s\p{Cf}]*[:：])/giu, '\\$1$2')
}

// options.attributed marks a shared chat's message (#1784): options.speaker
// (a cleaned author, null for a message no member sent) leads the prompt
// with speakerLine, and the text's own "[From:" lines are escaped.
export function prepareMessage(text, requestedAttachments, options = {}) {
  if (typeof text !== 'string') throw new Error('missing text')
  if (requestedAttachments != null && !Array.isArray(requestedAttachments)) throw new Error('attachments must be an array')
  if ((requestedAttachments?.length ?? 0) > MAX_ATTACHMENTS) throw new Error('too many attachments')
  const attachments = (requestedAttachments || []).map(cleanAttachment)
  if (attachments.some((attachment) => !attachment)) throw new Error('invalid attachment')
  if (text.trim() === '' && attachments.length === 0) throw new Error('missing text')

  const visibleText = text.trim()
  const attributed = options.attributed === true || !!options.speaker
  const speaker = speakerLine(options.speaker)
  const lead = speaker ? `${speaker}\n` : ''
  const body = attributed ? escapeSpeakerLines(visibleText) : visibleText
  if (attachments.length === 0) return { prompt: `${lead}${body}`, text: visibleText, attachments }
  const references = attachments.map((attachment) =>
    `- ${JSON.stringify(attachment.path)} (${attachment.mime_type}, ${attachment.size} bytes)`).join('\n')
  return {
    prompt: `${lead}${body}${body ? '\n\n' : ''}${ATTACHED_CONTEXT_MARKER}\n` +
      'The user attached these validated files from the current workspace. Read them with your file tools before relying on their contents:\n' +
      `${references}\n${ATTACHED_CONTEXT_END}`,
    text: visibleText,
    attachments,
  }
}
