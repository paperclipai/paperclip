export function createToolRepeatGuard(maxExecutions = 2) {
  const counts = new Map();
  return {
    record(signature) {
      const count = (counts.get(signature) || 0) + 1;
      counts.set(signature, count);
      return { count, execute: count <= maxExecutions };
    },
  };
}

export function dispositionForAgentResult(result) {
  return result?.partial === true ? "in_review" : "done";
}

export function bindToolArguments(toolName, args, runContext) {
  const bound = { ...(args || {}) };
  if (toolName === "queue_email_for_approval" && runContext?.issueId) {
    bound.issue_id = runContext.issueId;
  }
  return bound;
}

export function approvalQueueStopsRun(toolName, result) {
  if (toolName !== "queue_email_for_approval" || !result || result.ok !== true) return false;
  return result.queued === true || result.awaiting_human === true;
}

export function pluginToolExecutionContent(execution) {
  const content = execution?.result?.content ?? execution?.content;
  if (typeof content === "string") return content;
  return JSON.stringify(
    execution?.result?.data ??
    execution?.data ??
    execution?.result ??
    execution,
  );
}

export function pendingHumanApproval(interactions) {
  const list = Array.isArray(interactions)
    ? interactions
    : interactions?.interactions ?? interactions?.data ?? [];
  return list.find((interaction) =>
    interaction?.status === "pending" &&
    (interaction?.kind === "request_confirmation" ||
      interaction?.kind === "request_checkbox_confirmation"));
}

export function latestHumanRevisionFeedback(interactions) {
  const list = Array.isArray(interactions)
    ? interactions
    : interactions?.interactions ?? interactions?.data ?? [];
  return list
    .filter((interaction) =>
      interaction?.status === "rejected" &&
      typeof interaction?.result?.reason === "string" &&
      interaction.result.reason.trim())
    .sort((a, b) =>
      new Date(b.resolvedAt || b.updatedAt || b.createdAt || 0).getTime() -
      new Date(a.resolvedAt || a.updatedAt || a.createdAt || 0).getTime())
    [0]?.result?.reason?.trim() || "";
}
