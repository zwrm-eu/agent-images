// Durable identities for transport-to-harness handoff. These receipts never
// wait for a model turn: the harness's own queue receives input immediately.
// A crash in the non-transactional harness call is explicitly uncertain. We
// retain its identity instead of silently executing the same request twice.
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

function failure(message, status = 409) {
  return Object.assign(new Error(message), { status })
}

export class MessageReceipts {
  constructor(directory, generation = randomUUID()) {
    this.directory = resolve(directory)
    this.generation = generation
    this.records = new Map()
    const firstCreated = mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (firstCreated) {
      // Persist newly created directory entries too, before acknowledging
      // anything stored beneath them (including the first message ever).
      for (let current = this.directory; ; current = dirname(current)) {
        const fd = openSync(current, 'r')
        try { fsyncSync(fd) } finally { closeSync(fd) }
        if (current === dirname(firstCreated)) break
      }
    }
  }

  file(id) {
    return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`)
  }

  read(id) {
    if (this.records.has(id)) return this.records.get(id)
    try {
      const value = JSON.parse(readFileSync(this.file(id), 'utf8'))
      if (value.message_id !== id) throw new Error('invalid message receipt')
      this.records.set(id, value)
      return value
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err // corruption or I/O failure never means "not delivered"
    }
  }

  save(record) {
    const target = this.file(record.message_id)
    const temporary = `${target}.${randomUUID()}.tmp`
    let fd
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify(record))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, target)
      const directory = openSync(this.directory, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch (err) { if (err.code !== 'ENOENT') throw err }
    }
  }

  accept(id, sessionId, payload, enqueue) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw failure('invalid message_id', 400)
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    let record = this.read(id)
    if (record) {
      if (record.fingerprint !== fingerprint) throw failure('message_id_payload_conflict')
      if (record.status === 'completed' ||
          (record.status === 'accepted' && record.generation === this.generation && record.session_id === sessionId)) {
        this.save(record) // also repairs a failed receipt write in this process
        return { message_id: id, status: record.status, duplicate: true }
      }
      if (record.status !== 'pending') throw failure('message_handoff_outcome_unknown')
    }
    record = {
      message_id: id, fingerprint, session_id: sessionId,
      generation: this.generation, status: 'dispatching',
      updated_at: new Date().toISOString(),
    }
    // Synchronous fsync + queueMessage means two HTTP requests cannot race
    // each other through the admission window in Node's event loop.
    this.save(record)
    this.records.set(id, record)
    if (!enqueue()) {
      record.status = 'pending' // queue explicitly refused: safe to retry
      this.save(record)
      throw failure('session is not accepting messages')
    }
    record.status = 'accepted'
    this.save(record)
    return { message_id: id, status: 'accepted', duplicate: false }
  }

  // Called only at the driver's drained idle boundary. Interrupts/end do not
  // prove the harness consumed every queued follow-up and must not call this.
  complete(sessionId) {
    const completed = []
    for (const record of this.records.values()) {
      if (record.session_id !== sessionId || record.generation !== this.generation || record.status !== 'accepted') continue
      record.status = 'completed'
      record.updated_at = new Date().toISOString()
      try { this.save(record) } catch (err) { record.status = 'accepted'; throw err }
      completed.push(record.message_id)
    }
    return completed
  }
}
