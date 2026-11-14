import { isPluginOperationIssueOriginKind, type BuiltInIssueOriginKind } from "@paperclipai/shared";

/**
 * Who made a task, as the inbox "Source" grouping shows it:
 * - work: a person or an agent made it
 * - routines: a routine run made it
 * - system: Paperclip made it itself (watchdog, recovery, stuck-run checks)
 * - chat: a chat channel made it
 */
export type IssueSourceGroup = "work" | "routines" | "system" | "chat";

export const ISSUE_SOURCE_GROUP_ORDER: readonly IssueSourceGroup[] = ["work", "routines", "system", "chat"];

export const ISSUE_SOURCE_GROUP_LABELS: Record<IssueSourceGroup, string> = {
  work: "Work",
  routines: "Routines",
  system: "System",
  chat: "Chat",
};

const SOURCE_GROUP_BY_ORIGIN_KIND: Record<BuiltInIssueOriginKind, IssueSourceGroup> = {
  manual: "work",
  onboarding_first_task: "work",
  routine_execution: "routines",
  stale_active_run_evaluation: "system",
  harness_liveness_escalation: "system",
  issue_productivity_review: "system",
  stranded_issue_recovery: "system",
  task_watchdog: "system",
  task_watchdog_product_bug: "system",
  chat_channel: "chat",
};

export function issueSourceGroup(originKind: string | null | undefined): IssueSourceGroup {
  if (!originKind) return "work";
  const known = (SOURCE_GROUP_BY_ORIGIN_KIND as Record<string, IssueSourceGroup | undefined>)[originKind];
  if (known) return known;
  if (isPluginOperationIssueOriginKind(originKind)) return "system";
  // Other origins (plugin tasks, task bridges) are made on behalf of a person or an agent.
  return "work";
}
