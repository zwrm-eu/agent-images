// Platform run tool (#1392) — see sleep.ts for the channel rationale.
import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Pause this run until an ISO-8601 UTC timestamp (at most 21600 seconds = 6 hours from now) and resume exactly here — the VM is suspended while sleeping. For longer or open-ended waits, end your final turn with a precise handoff instead.",
  args: {
    timestamp: tool.schema.string().describe("ISO-8601 timestamp with a timezone, e.g. 2026-07-10T18:00:00Z"),
  },
  async execute(args) {
    const res = await fetch(`${process.env.ZWRM_PLATFORM_TOOLS_URL}/sleep_until`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.ZWRM_PLATFORM_TOOLS_TOKEN ?? ""}`,
      },
      body: JSON.stringify({ timestamp: args.timestamp }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(String(body?.error ?? `platform tool failed (${res.status})`))
    return String(body?.text ?? "")
  },
})
