import type {
  TaskChatAutoReview,
  TaskChatItem,
  TaskChatProviderActivityItem,
} from "./task-chat-model";

const TARGET_LABEL = "Target Execution Id";

function detail(item: TaskChatProviderActivityItem, label: string): string | undefined {
  const value = item.details.find((entry) => entry.label === label)?.value?.trim();
  return value ? value : undefined;
}

function isApprovedReview(item: TaskChatItem): item is TaskChatProviderActivityItem {
  return item.kind === "protocol"
    && item.surface === "provider_activity"
    && item.family === "safety"
    && item.status !== "running"
    && detail(item, "Decision") === "allowed";
}

/** The execution id a tool row was built from, matching how the adapter keys it. */
function executionIdOf(item: TaskChatItem, runId: string): string | undefined {
  if (item.kind === "tool") {
    const prefix = `${runId}:tool:`;
    return item.id.startsWith(prefix) ? item.id.slice(prefix.length) : undefined;
  }
  if (item.kind === "protocol" && item.surface === "provider_activity" && item.family === "tool_execution") {
    const prefix = `${runId}:provider:tool_execution:`;
    if (!item.id.startsWith(prefix)) return undefined;
    const rest = item.id.slice(prefix.length);
    const separator = rest.lastIndexOf(":");
    return separator > 0 ? rest.slice(0, separator) : undefined;
  }
  return undefined;
}

/**
 * An approved automatic review is metadata about the command it approved, so
 * it becomes a badge on that tool row instead of a duplicate row. Reviews
 * that stopped an action, are still in progress, or have no tool row (network
 * access, permission requests) keep their own governance row.
 */
export function foldApprovedAutoReviews(items: TaskChatItem[], runId: string): TaskChatItem[] {
  const toolsByExecution = new Map<string, number>();
  items.forEach((item, index) => {
    const executionId = executionIdOf(item, runId);
    if (executionId) toolsByExecution.set(executionId, index);
  });
  if (toolsByExecution.size === 0) return items;
  const folded = new Set<number>();
  items.forEach((item, index) => {
    if (!isApprovedReview(item)) return;
    const target = detail(item, TARGET_LABEL);
    const toolIndex = target ? toolsByExecution.get(target) : undefined;
    if (toolIndex == null) return;
    const tool = items[toolIndex];
    const review: TaskChatAutoReview = {
      decision: "allowed",
      riskLevel: detail(item, "Risk Level"),
      userConsent: detail(item, "User Consent"),
      rationale: item.summary?.trim() || detail(item, "Rationale"),
    };
    if (tool.kind === "tool" || (tool.kind === "protocol" && tool.surface === "provider_activity")) {
      tool.autoReview = review;
      folded.add(index);
    }
  });
  return folded.size === 0 ? items : items.filter((_, index) => !folded.has(index));
}
