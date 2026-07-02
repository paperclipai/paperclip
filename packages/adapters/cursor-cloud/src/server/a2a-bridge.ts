/**
 * Tier 1 stub — Cursor Cloud does not expose a public A2A endpoint yet.
 * Heartbeat may route CEO→Dev delegation through Paperclip wakeup until Cursor ships native A2A.
 */
export type CursorA2ABridgeRequest = {
  sourceAgentId: string;
  targetAgentId: string;
  message: string;
  issueId?: string;
};

export function buildCursorA2ABridgeWakeupPayload(input: CursorA2ABridgeRequest): Record<string, unknown> {
  return {
    wakeReason: "a2a_delegate",
    taskId: input.issueId ?? null,
    issueId: input.issueId ?? null,
    paperclipSessionHandoffMarkdown: [
      "## A2A delegation (Paperclip bridge)",
      `From agent: ${input.sourceAgentId}`,
      "",
      input.message,
    ].join("\n"),
  };
}
