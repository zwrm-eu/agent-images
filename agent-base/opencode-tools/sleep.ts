// Platform run tool (#1392): baked into the agent image at
// /etc/opencode/run/tool/, discovered only when the agentd opencode driver
// points OPENCODE_CONFIG_DIR there (unattended runs; interactive sessions
// get none — a human is on the stream). Executes inside OpenCode's Bun
// runtime and LONG-POLLS the daemon, which parks the turn; the plain fetch
// carries no client timeout, and the suspended VM freezes it with everything
// else. Semantics and model-facing text mirror the other harnesses' sleep.
import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Pause this run for a number of seconds (max 21600 = 6 hours) and resume exactly here — the VM is suspended while sleeping, so waiting costs nothing. Use this for short waits mid-task (a build farm, a rate limit, a colleague's quick reply). For longer or open-ended waits, do NOT sleep: end your final turn with a precise handoff instead — the conversation can be continued later with full context.",
  args: {
    seconds: tool.schema.number().int().min(1).max(21600).describe("How long to sleep, in seconds"),
  },
  async execute(args) {
    const res = await fetch(`${process.env.ZWRM_PLATFORM_TOOLS_URL}/sleep`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.ZWRM_PLATFORM_TOOLS_TOKEN ?? ""}`,
      },
      body: JSON.stringify({ seconds: args.seconds }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(String(body?.error ?? `platform tool failed (${res.status})`))
    return String(body?.text ?? "")
  },
})
