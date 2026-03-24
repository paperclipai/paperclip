import type {
  Approval,
  DashboardSummary,
  HeartbeatRun,
  Issue,
  JoinRequest,
} from "@paperclipai/shared";

export const RECENT_ISSUES_LIMIT = 100;
export const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
export const ACTIONABLE_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);
export const DISMISSED_KEY = "paperclip:inbox:dismissed";
export const INBOX_LAST_TAB_KEY = "paperclip:inbox:last-tab";
export type InboxTab = "recent" | "unread" | "all";
export type InboxApprovalFilter = "all" | "actionable" | "resolved";
export type InboxWorkItem =
  | {
      kind: "issue";
      timestamp: number;
      issue: Issue;
    }
  | {
      kind: "approval";
      timestamp: number;
      approval: Approval;
    }
  | {
      kind: "failed_run";
      timestamp: number;
      run: HeartbeatRun;
    }
  | {
      kind: "join_request";
      timestamp: number;
      joinRequest: JoinRequest;
    };

export interface InboxBadgeData {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  unreadTouchedIssues: number;
  alerts: number;
}

export function loadDismissedInboxItems(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function saveDismissedInboxItems(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadLastInboxTab(): InboxTab {
  try {
    const raw = localStorage.getItem(INBOX_LAST_TAB_KEY);
    if (raw === "all" || raw === "unread" || raw === "recent") return raw;
    if (raw === "new") return "recent";
    return "recent";
  } catch {
    return "recent";
  }
}

export function saveLastInboxTab(tab: InboxTab) {
  try {
    localStorage.setItem(INBOX_LAST_TAB_KEY, tab);
  } catch {
    // Ignore localStorage failures.
  }
}

export function getLatestFailedRunsByAgent(runs: HeartbeatRun[]): HeartbeatRun[] {
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const latestByAgent = new Map<string, HeartbeatRun>();

  for (const run of sorted) {
    if (!latestByAgent.has(run.agentId)) {
      latestByAgent.set(run.agentId, run);
    }
  }

  return Array.from(latestByAgent.values()).filter((run) => FAILED_RUN_STATUSES.has(run.status));
}

export function normalizeTimestamp(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function issueLastActivityTimestamp(issue: Issue): number {
  const lastExternalCommentAt = normalizeTimestamp(issue.lastExternalCommentAt);
  if (lastExternalCommentAt > 0) return lastExternalCommentAt;

  const updatedAt = normalizeTimestamp(issue.updatedAt);
  const myLastTouchAt = normalizeTimestamp(issue.myLastTouchAt);
  if (myLastTouchAt > 0 && updatedAt <= myLastTouchAt) return 0;

  return updatedAt;
}

export function sortIssuesByMostRecentActivity(a: Issue, b: Issue): number {
  const activityDiff = issueLastActivityTimestamp(b) - issueLastActivityTimestamp(a);
  if (activityDiff !== 0) return activityDiff;
  return normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt);
}

export function getRecentTouchedIssues(issues: Issue[]): Issue[] {
  return [...issues].sort(sortIssuesByMostRecentActivity).slice(0, RECENT_ISSUES_LIMIT);
}

export function getUnreadTouchedIssues(issues: Issue[]): Issue[] {
  return issues.filter((issue) => issue.isUnreadForMe);
}

export function getApprovalsForTab(
  approvals: Approval[],
  tab: InboxTab,
  filter: InboxApprovalFilter,
): Approval[] {
  const sortedApprovals = [...approvals].sort(
    (a, b) => normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt),
  );

  if (tab === "recent") return sortedApprovals;
  if (tab === "unread") {
    return sortedApprovals.filter((approval) => ACTIONABLE_APPROVAL_STATUSES.has(approval.status));
  }
  if (filter === "all") return sortedApprovals;

  return sortedApprovals.filter((approval) => {
    const isActionable = ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
    return filter === "actionable" ? isActionable : !isActionable;
  });
}

export function approvalActivityTimestamp(approval: Approval): number {
  const updatedAt = normalizeTimestamp(approval.updatedAt);
  if (updatedAt > 0) return updatedAt;
  return normalizeTimestamp(approval.createdAt);
}

export function getInboxWorkItems({
  issues,
  approvals,
  failedRuns = [],
  joinRequests = [],
}: {
  issues: Issue[];
  approvals: Approval[];
  failedRuns?: HeartbeatRun[];
  joinRequests?: JoinRequest[];
}): InboxWorkItem[] {
  return [
    ...issues.map((issue) => ({
      kind: "issue" as const,
      timestamp: issueLastActivityTimestamp(issue),
      issue,
    })),
    ...approvals.map((approval) => ({
      kind: "approval" as const,
      timestamp: approvalActivityTimestamp(approval),
      approval,
    })),
    ...failedRuns.map((run) => ({
      kind: "failed_run" as const,
      timestamp: normalizeTimestamp(run.createdAt),
      run,
    })),
    ...joinRequests.map((joinRequest) => ({
      kind: "join_request" as const,
      timestamp: normalizeTimestamp(joinRequest.createdAt),
      joinRequest,
    })),
  ].sort((a, b) => {
    const timestampDiff = b.timestamp - a.timestamp;
    if (timestampDiff !== 0) return timestampDiff;

    if (a.kind === "issue" && b.kind === "issue") {
      return sortIssuesByMostRecentActivity(a.issue, b.issue);
    }
    if (a.kind === "approval" && b.kind === "approval") {
      return approvalActivityTimestamp(b.approval) - approvalActivityTimestamp(a.approval);
    }

    return a.kind === "approval" ? -1 : 1;
  });
}

export function shouldShowInboxSection({
  tab,
  hasItems,
  showOnRecent,
  showOnUnread,
  showOnAll,
}: {
  tab: InboxTab;
  hasItems: boolean;
  showOnRecent: boolean;
  showOnUnread: boolean;
  showOnAll: boolean;
}): boolean {
  if (!hasItems) return false;
  if (tab === "recent") return showOnRecent;
  if (tab === "unread") return showOnUnread;
  return showOnAll;
}

export function computeInboxBadgeData({
  approvals,
  joinRequests,
  dashboard,
  heartbeatRuns,
  unreadIssues,
  dismissed,
}: {
  approvals: Approval[];
  joinRequests: JoinRequest[];
  dashboard: DashboardSummary | undefined;
  heartbeatRuns: HeartbeatRun[];
  unreadIssues: Issue[];
  dismissed: Set<string>;
}): InboxBadgeData {
  const actionableApprovals = approvals.filter((approval) =>
    ACTIONABLE_APPROVAL_STATUSES.has(approval.status),
  ).length;
  const failedRuns = getLatestFailedRunsByAgent(heartbeatRuns).filter(
    (run) => !dismissed.has(`run:${run.id}`),
  ).length;
  const unreadTouchedIssues = unreadIssues.length;
  const agentErrorCount = dashboard?.agents.error ?? 0;
  const monthBudgetCents = dashboard?.costs.monthBudgetCents ?? 0;
  const monthUtilizationPercent = dashboard?.costs.monthUtilizationPercent ?? 0;
  const showAggregateAgentError =
    agentErrorCount > 0 &&
    failedRuns === 0 &&
    !dismissed.has("alert:agent-errors");
  const showBudgetAlert =
    monthBudgetCents > 0 &&
    monthUtilizationPercent >= 80 &&
    !dismissed.has("alert:budget");
  const alerts = Number(showAggregateAgentError) + Number(showBudgetAlert);

  return {
    inbox: actionableApprovals + joinRequests.length + failedRuns + unreadTouchedIssues + alerts,
    approvals: actionableApprovals,
    failedRuns,
    joinRequests: joinRequests.length,
    unreadTouchedIssues,
    alerts,
  };
}
