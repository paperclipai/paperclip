import type { ToolInvocationStatus } from "@paperclipai/shared";

const PREPARATION_STATUSES = new Set<ToolInvocationStatus>([
  "pending",
  "authorized",
  "awaiting_approval",
]);

export function extendApprovedExecutionWaitDeadline(input: {
  currentDeadlineMs: number;
  invocationStatus: ToolInvocationStatus;
  invocationStartedAt: Date | null;
  executionWaitMs: number;
}): number {
  if (!input.invocationStartedAt || PREPARATION_STATUSES.has(input.invocationStatus)) {
    return input.currentDeadlineMs;
  }
  return Math.max(
    input.currentDeadlineMs,
    input.invocationStartedAt.getTime() + input.executionWaitMs,
  );
}
