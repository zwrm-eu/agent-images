// Workspace file API helpers (#732, #1666): the pieces of server.mjs's file
// handlers that tests can reach without booting the daemon.

import { statfs } from 'node:fs/promises'
import { Transform } from 'node:stream'

const MiB = 1024 * 1024

// A user's upload never takes the workspace volume's last MIN_FREE_BYTES
// (#1666). The harness, git and the agent's own tools keep writing to $HOME,
// and chat uploads stay on the volume until the workspace is deleted. A volume
// filled to its last block breaks the next turn; refusing the upload leaves
// the session working and tells the uploader why. Only uploads through the
// control plane's public file API ask for this (keep_free=true): the
// platform's own writes (skills, memories, run inputs) are what the reserve
// is kept for.
export const MIN_FREE_BYTES = 256 * MiB

// An upload re-reads the volume's free space every FREE_CHECK_BYTES, so
// uploads running side by side each see what the others have written. ext4
// counts delayed-allocation data against free space as soon as it is
// written, before it reaches the disk.
export const FREE_CHECK_BYTES = 4 * MiB

// uploadBudget returns how many bytes an upload into dir may write before it
// reaches MIN_FREE_BYTES. It is negative once the volume is past the reserve.
export async function uploadBudget(dir, stat = statfs) {
  const st = await stat(dir)
  return st.bavail * st.bsize - MIN_FREE_BYTES
}

// volumeFullError is the 507 an upload gets for crossing its budget.
export function volumeFullError(budget) {
  const free = Math.max(0, Math.floor((budget + MIN_FREE_BYTES) / MiB))
  const e = new Error(`not enough space on the workspace volume (${free} MiB free, ${MIN_FREE_BYTES / MiB} MiB is kept for the agent)`)
  e.status = 507
  return e
}

// UploadCounter passes a write's bytes through, counting them in size. It
// refuses the write past maxBytes (400) and, with keepFree, once the volume
// under root is past MIN_FREE_BYTES. That refusal lands in refused (a 507)
// rather than failing the stream: the counter then drops the remaining bytes
// but keeps reading them, and the caller throws refused once the body is in.
// An answer sent while the client is still writing reaches a Go client as a
// connection reset, not as the 507. The drain is bounded by maxBytes.
export class UploadCounter extends Transform {
  constructor({ maxBytes, keepFree = false, root, stat = statfs }) {
    super()
    Object.assign(this, { maxBytes, keepFree, root, stat, size: 0, nextCheck: 0, refused: null })
  }

  _transform(chunk, _enc, cb) {
    this.size += chunk.length
    if (this.size > this.maxBytes) {
      const e = new Error(`file too large (max ${this.maxBytes / MiB}MB)`)
      e.status = 400
      return cb(e)
    }
    if (this.refused) return cb()
    if (!this.keepFree || this.size < this.nextCheck) return cb(null, chunk)
    this.nextCheck = this.size + FREE_CHECK_BYTES
    uploadBudget(this.root, this.stat).then((budget) => {
      if (budget < 0) this.refused = volumeFullError(budget)
      cb(null, this.refused ? undefined : chunk)
    }, cb)
  }
}

// byteRange parses a single `bytes=START-END` or `bytes=START-` Range header
// against a file of size bytes. The control plane uses it to read the head of
// every chat attachment (#1666), so it no longer has to close a connection
// that is streaming the rest of a 100 MiB file. Every other form (suffix or
// multiple ranges, a start past the end, which includes any empty file) gets
// null, and the caller serves the whole file, as HTTP allows.
export function byteRange(header, size) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header ?? '')
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (!Number.isSafeInteger(start) || start > end) return null
  return { start, end }
}
