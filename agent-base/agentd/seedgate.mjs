// Seed gate (#1136): the init script seeds $HOME from the image skel in a
// backgrounded subshell, marking progress with sentinel files under /run —
// .zwrm-seeding-<mp> while the copy runs, .zwrm-seed-failed-<mp> if the
// volume could not be fully populated (the same markers the SSH login
// profile reads). A harness must never run against a half-seeded home
// (#1119), but the daemon itself has to be up immediately: gating the daemon
// LAUNCH on the seed put the multi-second first-boot copy in front of the
// control plane's 20s session-create readiness budget and killed every fresh
// workspace boot (#1136). So the gate lives here instead, at harness spawn:
// session create is accepted at once and the driver starts when the sentinel
// clears.

import { readdir } from 'node:fs/promises'

// Long enough for a full skel copy onto a slow, contended disk; a seed that
// is still running after this is wedged, and a stated error beats an
// eternally "starting" session.
export const SEED_WAIT_MAX_MS = 300_000

export const SEED_FAILED_MESSAGE =
  'workspace home volume seeding failed — $HOME is incomplete (likely out of disk space); ' +
  'check the VM console log for "volume seeding FAILED", then grow the volume or free space and restart the workspace VM'

// seedState reports 'failed' | 'seeding' | 'clear' for ANY volume: a session
// spans $HOME, and $HOME is the only skel-seeded mountpoint in practice.
// 'failed' wins over 'seeding' — the failure marker is terminal for this
// boot. An unreadable /run fails open: never refuse a session on evidence we
// do not have.
export async function seedState(runDir = '/run') {
  let names
  try {
    names = await readdir(runDir)
  } catch {
    return 'clear'
  }
  if (names.some((n) => n.startsWith('.zwrm-seed-failed-'))) return 'failed'
  if (names.some((n) => n.startsWith('.zwrm-seeding-'))) return 'seeding'
  return 'clear'
}

// waitSeedClear polls until seeding resolves one way or the other. Returns
// 'clear' | 'failed' | 'timeout' | 'cancelled'. `cancelled` lets a
// superseded or ended session stop waiting without burning the full window.
export async function waitSeedClear({
  runDir = '/run',
  maxMs = SEED_WAIT_MAX_MS,
  pollMs = 500,
  cancelled = () => false,
} = {}) {
  const deadline = Date.now() + maxMs
  for (;;) {
    const st = await seedState(runDir)
    if (st !== 'seeding') return st
    if (cancelled()) return 'cancelled'
    if (Date.now() >= deadline) return 'timeout'
    await new Promise((r) => setTimeout(r, pollMs))
  }
}
