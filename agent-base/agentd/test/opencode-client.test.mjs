// OpenCodeServer bootstrap contract (#1429): the `subscribed` promise gates
// the driver's first prompt on the /event stream, so its settle behaviour on
// the bootstrap-failure paths is load-bearing. A construction failure
// (start()/create) calls close() BEFORE the driver has awaited subscribed, so
// that rejection must never surface as an unhandledRejection — the regression
// this pins.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeServer } from '../drivers/opencode-client.mjs'

test('close() before subscribe does not leak an unhandled rejection', async () => {
  // Reproduce the real path: nobody awaits server.subscribed (the early-error
  // path throws its own error and returns). Without the constructor's
  // permanent no-op reaction, close()'s rejection here has no handler.
  const server = new OpenCodeServer({ env: { ZWRM_OPENCODE_URL: 'http://127.0.0.1:1' } })
  await server.start() // attach mode: no child, no event loop
  let unhandled = null
  const onUnhandled = (err) => { unhandled = err }
  process.on('unhandledRejection', onUnhandled)
  try {
    server.close() // rejects `subscribed`; nothing is awaiting it
    await new Promise((r) => setTimeout(r, 20)) // let the detector run
    assert.equal(unhandled, null, 'close() before subscribe leaked an unhandled rejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a real awaiter still observes the bootstrap rejection', async () => {
  const server = new OpenCodeServer({ env: { ZWRM_OPENCODE_URL: 'http://127.0.0.1:1' } })
  await server.start()
  server.close()
  await assert.rejects(() => server.subscribed, /closed before the event stream connected/)
  // Idempotent: a second close() is a no-op on the settled promise.
  assert.doesNotThrow(() => server.close())
})
