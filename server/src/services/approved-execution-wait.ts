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
  preparationStartedAt: Date | null;
  preparationWaitMs: number;
  executionWaitMs: number;
}): number {
  if (PREPARATION_STATUSES.has(input.invocationStatus)) {
    return input.preparationStartedAt
      ? Math.max(
          input.currentDeadlineMs,
          input.preparationStartedAt.getTime() + input.preparationWaitMs,
        )
      : input.currentDeadlineMs;
  }
  if (!input.invocationStartedAt) {
    return input.currentDeadlineMs;
  }
  return Math.max(
    input.currentDeadlineMs,
    input.invocationStartedAt.getTime() + input.executionWaitMs,
  );
}
