import { type ActivityEvent, type Agent, type HeartbeatRun, type Issue, type IssueStatus } from "@paperclipai/shared";

export const dashboardObservabilityStatusOrder: IssueStatus[] = [
  "backlog",
  "todo",
  "claimed",
  "in_progress",
  "handoff_ready",
  "technical_review",
  "changes_requested",
  "human_review",
  "blocked",
];

const WIP_STATUSES = new Set<IssueStatus>([
  "claimed",
  "in_progress",
  "handoff_ready",
  "technical_review",
  "changes_requested",
  "human_review",
]);

const TECH_QUEUE_STATUSES = new Set<IssueStatus>([
  "handoff_ready",
  "technical_review",
  "changes_requested",
]);

/** Substrings matched against `issue.originId` for `agent_health_alert` issues (broader tokens first is fine). */
const ADAPTER_ALERT_MARKERS = [
  ":health:unknown_adapter",
  ":health:runtime_adapter_divergence",
  ":health:environment_",
] as const;

export interface DashboardObservabilityAgentRow {
  key: string;
  agentId: string | null;
  agentName: string;
  adapterType: string | null;
  status: string | null;
  totalOpen: number;
  wipCount: number;
  statusCounts: Partial<Record<IssueStatus, number>>;
  lastHeartbeatAt: Date | string | null;
  lastUsefulHeartbeatAt: Date | string | null;
  latestFailureRun: HeartbeatRun | null;
  adapterAlerts: Issue[];
}

export interface DashboardObservabilitySummary {
  openCount: number;
  wipCount: number;
  technicalQueueCount: number;
  staleOver24hCount: number;
  adapterAlertCount: number;
  duplicateReviewPreventionCount24h: number;
  healthAlertReopenSuppressedCount24h: number;
  /** `issue.review_dispatch_noop` in the last 24h (reviewer missing/ambiguous or PR not found). */
  reviewDispatchNoopCount24h: number;
  /** `issue.merge_delegate_wakeup_failed` in the last 24h (executor wake after approved review). */
  mergeDelegateWakeupFailedCount24h: number;
}

export interface DashboardObservabilityData {
  summary: DashboardObservabilitySummary;
  visibleStatuses: IssueStatus[];
  agentRows: DashboardObservabilityAgentRow[];
  technicalQueue: Issue[];
  /** Open issues sorted by `updatedAt` ascending (oldest activity first). */
  openIssuesByUpdateTime: Issue[];
  adapterAlerts: Issue[];
}

function toTimestamp(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isOpenIssue(issue: Issue): boolean {
  return issue.status !== "done" && issue.status !== "cancelled";
}

function isAdapterAlertIssue(issue: Issue): boolean {
  if (issue.originKind !== "agent_health_alert") return false;
  const originId = issue.originId;
  if (typeof originId !== "string") return false;
  return ADAPTER_ALERT_MARKERS.some((marker) => originId.includes(marker));
}

function parseAgentIdFromOrigin(originId: string | null | undefined): string | null {
  if (typeof originId !== "string") return null;
  const match = /^agent:([^:]+):health:/.exec(originId);
  return match?.[1] ?? null;
}

function compareByDateDesc(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
): number {
  return (toTimestamp(right) ?? 0) - (toTimestamp(left) ?? 0);
}

function compareByDateAsc(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
): number {
  return (toTimestamp(left) ?? 0) - (toTimestamp(right) ?? 0);
}

export function deriveDashboardObservability(input: {
  agents: Agent[];
  issues: Issue[];
  runs: HeartbeatRun[];
  activity: ActivityEvent[];
  now?: Date;
}): DashboardObservabilityData {
  const now = input.now ?? new Date();
  const staleThresholdMs = 24 * 60 * 60 * 1000;
  const recentCutoffMs = now.getTime() - staleThresholdMs;

  const openIssues = input.issues.filter(isOpenIssue);
  const technicalQueue = openIssues
    .filter((issue) => TECH_QUEUE_STATUSES.has(issue.status))
    .sort((left, right) => compareByDateAsc(left.updatedAt, right.updatedAt));
  const openIssuesByUpdateTime = [...openIssues].sort((left, right) =>
    compareByDateAsc(left.updatedAt, right.updatedAt),
  );
  const adapterAlerts = openIssues
    .filter(isAdapterAlertIssue)
    .sort((left, right) => compareByDateDesc(left.updatedAt, right.updatedAt));

  const issuesByAssignee = new Map<string, Issue[]>();
  for (const issue of openIssues) {
    const key = issue.assigneeAgentId ?? "unassigned";
    const list = issuesByAssignee.get(key) ?? [];
    list.push(issue);
    issuesByAssignee.set(key, list);
  }

  const runsByAgentId = new Map<string, HeartbeatRun[]>();
  for (const run of [...input.runs].sort((left, right) => compareByDateDesc(left.createdAt, right.createdAt))) {
    const list = runsByAgentId.get(run.agentId) ?? [];
    list.push(run);
    runsByAgentId.set(run.agentId, list);
  }

  const adapterAlertsByAgentId = new Map<string, Issue[]>();
  for (const issue of adapterAlerts) {
    const agentId = parseAgentIdFromOrigin(issue.originId);
    if (!agentId) continue;
    const list = adapterAlertsByAgentId.get(agentId) ?? [];
    list.push(issue);
    adapterAlertsByAgentId.set(agentId, list);
  }

  const agentRows: DashboardObservabilityAgentRow[] = input.agents.map((agent) => {
    const assignedIssues = issuesByAssignee.get(agent.id) ?? [];
    const runs = runsByAgentId.get(agent.id) ?? [];
    const lastUsefulRun =
      runs.find(
        (run) =>
          run.status !== "queued"
          && run.status !== "running"
          && run.operationalEffect?.producedEffect,
      ) ?? null;
    const latestFailureRun =
      runs.find(
        (run) =>
          (run.status === "failed" || run.status === "timed_out")
          && !run.operationalEffect?.producedEffect,
      )
      ?? runs.find((run) => run.status === "failed" || run.status === "timed_out")
      ?? null;

    const statusCounts: Partial<Record<IssueStatus, number>> = {};
    for (const issue of assignedIssues) {
      statusCounts[issue.status] = (statusCounts[issue.status] ?? 0) + 1;
    }

    return {
      key: agent.id,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
      status: agent.status,
      totalOpen: assignedIssues.length,
      wipCount: assignedIssues.filter((issue) => WIP_STATUSES.has(issue.status)).length,
      statusCounts,
      lastHeartbeatAt: agent.lastHeartbeatAt,
      lastUsefulHeartbeatAt: lastUsefulRun?.finishedAt ?? lastUsefulRun?.createdAt ?? null,
      latestFailureRun,
      adapterAlerts: adapterAlertsByAgentId.get(agent.id) ?? [],
    };
  });

  const unassignedIssues = issuesByAssignee.get("unassigned") ?? [];
  if (unassignedIssues.length > 0) {
    const statusCounts: Partial<Record<IssueStatus, number>> = {};
    for (const issue of unassignedIssues) {
      statusCounts[issue.status] = (statusCounts[issue.status] ?? 0) + 1;
    }
    agentRows.push({
      key: "unassigned",
      agentId: null,
      agentName: "Unassigned",
      adapterType: null,
      status: null,
      totalOpen: unassignedIssues.length,
      wipCount: unassignedIssues.filter((issue) => WIP_STATUSES.has(issue.status)).length,
      statusCounts,
      lastHeartbeatAt: null,
      lastUsefulHeartbeatAt: null,
      latestFailureRun: null,
      adapterAlerts: [],
    });
  }

  agentRows.sort((left, right) => {
    const leftIsUnassigned = left.agentId === null;
    const rightIsUnassigned = right.agentId === null;
    if (leftIsUnassigned !== rightIsUnassigned) return leftIsUnassigned ? 1 : -1;
    if (right.totalOpen !== left.totalOpen) return right.totalOpen - left.totalOpen;
    if (right.wipCount !== left.wipCount) return right.wipCount - left.wipCount;
    return left.agentName.localeCompare(right.agentName);
  });

  const visibleStatuses = dashboardObservabilityStatusOrder.filter((status) =>
    openIssues.some((issue) => issue.status === status),
  );
  const recentActivity = input.activity.filter((event) => {
    const createdAt = toTimestamp(event.createdAt);
    return createdAt !== null && createdAt >= recentCutoffMs;
  });
  const duplicateReviewPreventionCount24h = recentActivity.filter((event) =>
    event.action === "issue.review_dispatch_reused"
    && event.details != null
    && event.details.duplicatePrevented === true,
  ).length;
  const healthAlertReopenSuppressedCount24h = recentActivity.filter((event) =>
    event.action === "issue.health_alert_reopen_suppressed",
  ).length;
  const reviewDispatchNoopCount24h = recentActivity.filter((event) =>
    event.action === "issue.review_dispatch_noop",
  ).length;
  const mergeDelegateWakeupFailedCount24h = recentActivity.filter((event) =>
    event.action === "issue.merge_delegate_wakeup_failed",
  ).length;

  return {
    summary: {
      openCount: openIssues.length,
      wipCount: openIssues.filter((issue) => WIP_STATUSES.has(issue.status)).length,
      technicalQueueCount: technicalQueue.length,
      staleOver24hCount: openIssues.filter((issue) => {
        const updatedAt = toTimestamp(issue.updatedAt);
        return updatedAt !== null && now.getTime() - updatedAt >= staleThresholdMs;
      }).length,
      adapterAlertCount: adapterAlerts.length,
      duplicateReviewPreventionCount24h,
      healthAlertReopenSuppressedCount24h,
      reviewDispatchNoopCount24h,
      mergeDelegateWakeupFailedCount24h,
    },
    visibleStatuses,
    agentRows,
    technicalQueue,
    openIssuesByUpdateTime,
    adapterAlerts,
  };
}
