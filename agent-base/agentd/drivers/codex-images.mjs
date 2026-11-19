// Images from codex's built-in image tool (#2328). With a ChatGPT login,
// codex offers the model `image_gen` (the image generation ChatGPT itself
// uses) and reports each result as an `imageGeneration` thread item: the
// file codex saved under $CODEX_HOME/generated_images (`savedPath`), the
// image inline as base64 (`result`) on items that carry it, the prompt the
// model actually sent (`revisedPrompt`), and a `failure` when a plan limit
// stopped it.
//
// Codex's own instructions tell the model the image "is already displayed to
// the user", so the reply will not link it. The driver makes that true: it
// copies the image into the deliverables folder (~/outputs, #903, top level) and emits
// an assistant message holding a Markdown image of that file, which chat
// clients render the way they render any image the agent links from its
// workspace. The original stays where codex put it, because codex's
// image-editing references point at it.

import { constants, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

// fileStem turns codex's ids into a file name: ids are codex's own, but they
// still decide a path, so nothing outside a conservative set survives.
function fileStem(item) {
  const raw = String(item?.generationId || item?.id || '')
  const stem = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80)
  return stem || 'image'
}

// saveGeneratedImage copies the item's image into dir under a name of its own
// and returns that path, or null when the item carries no image (a failure,
// or a stored file id only). It never overwrites: a second image with the
// same id gets a numbered sibling. Synchronous on purpose: the driver emits
// items in the order codex reports them, and the image belongs between the
// messages around it.
export function saveGeneratedImage(item, dir) {
  const saved = typeof item?.savedPath === 'string' && item.savedPath ? item.savedPath : null
  const inline = typeof item?.result === 'string' && item.result ? item.result : null
  if (!saved && !inline) return null
  let ext = saved ? extname(saved).toLowerCase() : '.png'
  if (!IMAGE_EXTENSIONS.has(ext)) ext = '.png'
  mkdirSync(dir, { recursive: true })
  const stem = fileStem(item)
  for (let n = 1; n <= 1000; n++) {
    const dest = join(dir, n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`)
    if (existsSync(dest)) continue
    try {
      if (saved) {
        try {
          copyFileSync(saved, dest, constants.COPYFILE_EXCL)
          return dest
        } catch (err) {
          if (err?.code === 'EEXIST' || !inline) throw err
          // The file codex reported is gone; the inline copy is the same image.
        }
      }
      writeFileSync(dest, Buffer.from(inline, 'base64'), { flag: 'wx' })
      return dest
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
    }
  }
  throw new Error(`no free file name for ${stem}${ext} in ${dir}`)
}

// generatedImagePayload is the assistant message that shows the image: a
// Markdown image of the saved file, its alt text the prompt codex sent.
// `generated_image` marks it as the platform's, not the agent's words: the
// control plane leaves it out of what it relays as the agent's reply (a
// Teams note, a turn's text, a push notification), where a VM path means
// nothing.
export function generatedImagePayload(file, item, model) {
  const alt = String(item?.revisedPrompt || '')
    .replace(/[[\]\\\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Generated image'
  const href = encodeURI(file).replace(/\(/g, '%28').replace(/\)/g, '%29')
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `![${alt}](${href})` }], model: model || '' },
    generated_image: { path: file, prompt: String(item?.revisedPrompt || '') },
  }
}

// imageGenerationFailureText says why an image did not come, or returns null
// for an item that did not fail. The only failure codex names is a plan's
// image limit; its reset time is in epoch seconds.
export function imageGenerationFailureText(item) {
  const failure = item?.failure
  if (!failure || typeof failure !== 'object') return null
  if (failure.type === 'usageLimitExceeded') {
    const at = Number(failure.resetsAt)
    const reset = Number.isFinite(at) && at > 0
      ? ` It resets ${new Date(at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
      : ''
    return `Image generation stopped: the ChatGPT plan's image limit is used up.${reset}`
  }
  return 'Image generation failed.'
}

// imageMessage handles one completed imageGeneration item: it returns the
// assistant payload to emit (the image, or why there is none), or null with
// nothing to show. Errors saving the file are the caller's to log.
export function imageMessage(item, dir, model) {
  const failure = imageGenerationFailureText(item)
  if (failure) {
    return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: failure }], model: model || '' } }
  }
  const file = saveGeneratedImage(item, dir)
  return file ? generatedImagePayload(file, item, model) : null
}
