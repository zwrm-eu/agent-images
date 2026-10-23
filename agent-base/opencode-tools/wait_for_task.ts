// Platform tool (#1911) — see sleep.ts for the channel rationale. Baked into
// /etc/opencode/run/tool/ with the sleep tools and, alone, into
// /etc/opencode/session-tasks/tool/, the root the agentd opencode driver
// points chats with task_waits at. The daemon parks the turn until the task
// finishes, its agent asks a question, or the timeout passes. Semantics and
// model-facing text mirror the other harnesses' wait_for_task.
import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Wait here for a task you asked another agent for with delegate. Your turn pauses (the VM sleeps meanwhile, at no cost) until the task finishes, its agent asks you a question, or the timeout passes (at most 21600 seconds = 6 hours). It resumes here with what happened. Use it when you can't go on without the result; otherwise carry on or end your turn, and the result comes as a platform message.",
  args: {
    id: tool.schema.string().regex(/^task_[A-Za-z0-9-]{1,64}$/).describe("The task id delegate returned, like task_<uuid>"),
    timeout_seconds: tool.schema
      .number()
      .int()
      .min(1)
      .max(21600)
      .optional()
      .describe("How long to wait at most, in seconds (default and max 21600)"),
  },
  async execute(args) {
    const res = await fetch(`${process.env.ZWRM_PLATFORM_TOOLS_URL}/wait_for_task`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.ZWRM_PLATFORM_TOOLS_TOKEN ?? ""}`,
      },
      // An absent timeout_seconds stays absent (stringify drops undefined).
      body: JSON.stringify({ id: args.id, timeout_seconds: args.timeout_seconds }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(String(body?.error ?? `platform tool failed (${res.status})`))
    return String(body?.text ?? "")
  },
})
