// fakeHelpers is the parkTurn stand-in the run-tool tests share: it records
// every park request and resolves immediately with the wake text, so the
// dispatch and validation paths run without booting the daemon.
export const fakeHelpers = (parks, max = 21600) => ({
  MAX_SLEEP_SECONDS: max,
  parkTurn: async (s, kind, payload, deadline, resultText) => {
    parks.push({ kind, payload, deadline })
    return { content: [{ type: 'text', text: resultText('') }] }
  },
})
