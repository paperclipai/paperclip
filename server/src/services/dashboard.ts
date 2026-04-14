import { and, desc, eq, gte, isNull, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  companies,
  costEvents,
  heartbeatRuns,
  issues,
  joinRequests,
  projects,
} from "@paperclipai/db";
import type { DashboardAttentionItem, DashboardBriefTone } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const ACTIONABLE_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);
const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
const OPEN_ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const RECENT_ACTIVITY_WINDOW_DAYS = 7;

type IssueRow = {
  id: string;
  parentId: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  createdAt: Date;
};

type IssueActivityRow = {
  issueId: string;
  lastActivityAt: Date;
};

type LatestRunRow = {
  id: string;
  agentId: string;
  agentName: string;
  agentStatus: string;
  status: string;
  error: string | null;
  contextSnapshot: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

type FocusAreaBucket = {
  key: string;
  label: string;
  href: string;
  tone: DashboardBriefTone;
  changedIssueIds: Set<string>;
  memberIssueIds: Set<string>;
  blockedCount: number;
  failedRunCount: number;
  activeAgentIds: Set<string>;
  latestAt: Date;
  latestUpdate: string;
};

function humanizeToken(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatUsdCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function isOpenIssueStatus(status: string): boolean {
  return OPEN_ISSUE_STATUSES.has(status);
}

function toneRank(tone: DashboardBriefTone): number {
  switch (tone) {
    case "blocked":
      return 4;
    case "at_risk":
      return 3;
    case "watch":
      return 2;
    case "healthy":
    default:
      return 1;
  }
}

function severityRank(severity: DashboardAttentionItem["severity"]): number {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
    default:
      return 1;
  }
}

function attentionPriority(kind: DashboardAttentionItem["kind"]): number {
  switch (kind) {
    case "approval":
    case "join_request":
      return 1;
    case "run":
      return 2;
    case "issue":
    default:
      return 3;
  }
}

function resolveDashboardHealth(input: {
  blockedIssues: number;
  failedRuns: number;
  activeBudgetIncidents: number;
  decisions: number;
  agentErrors: number;
  utilizationPercent: number;
}): DashboardBriefTone {
  if (input.blockedIssues > 0 || input.activeBudgetIncidents > 0) return "blocked";
  if (input.failedRuns > 0 || input.agentErrors > 0) return "at_risk";
  if (input.decisions > 0 || input.utilizationPercent >= 80) return "watch";
  return "healthy";
}

function approvalTitle(row: { type: string; payload: Record<string, unknown> | null }): string {
  const payloadTitle = typeof row.payload?.title === "string" ? row.payload.title : null;
  return payloadTitle ?? humanizeToken(row.type);
}

function joinRequestTitle(row: {
  requestType: string;
  requestEmailSnapshot: string | null;
  agentName: string | null;
}): string {
  if (row.requestType === "human") {
    return row.requestEmailSnapshot
      ? `${row.requestEmailSnapshot} requests access`
      : "Human join request";
  }
  if (row.agentName) return `Agent join request: ${row.agentName}`;
  return `${humanizeToken(row.requestType)} join request`;
}

function linkedIssueId(contextSnapshot: Record<string, unknown> | null): string | null {
  const issueId = contextSnapshot?.issueId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

function linkedProjectId(payload: Record<string, unknown> | null): string | null {
  const direct = payload?.projectId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  return null;
}

function linkedApprovalIssueId(payload: Record<string, unknown> | null): string | null {
  const direct = payload?.issueId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const linked = payload?.linkedIssueId;
  return typeof linked === "string" && linked.length > 0 ? linked : null;
}

function topAncestorIssue(issue: IssueRow, issueById: ReadonlyMap<string, IssueRow>): IssueRow {
  let current = issue;
  const seen = new Set<string>([current.id]);

  while (current.parentId) {
    const parent = issueById.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }

  return current;
}

function focusAreaDescriptor(issue: IssueRow, issueById: ReadonlyMap<string, IssueRow>) {
  const root = topAncestorIssue(issue, issueById);

  if (issue.parentId || root.id !== issue.id) {
    return {
      key: `issue:${root.id}`,
      label: root.title,
      href: `/issues/${root.identifier ?? root.id}`,
    };
  }

  if (issue.projectId) {
    return {
      key: `project:${issue.projectId}`,
      label: issue.projectName ?? "Project work",
      href: `/projects/${issue.projectId}/issues`,
    };
  }

  return {
    key: "ops:general",
    label: "Operational work",
    href: "/issues",
  };
}

function ensureFocusArea(
  buckets: Map<string, FocusAreaBucket>,
  issue: IssueRow,
  issueById: ReadonlyMap<string, IssueRow>,
): FocusAreaBucket {
  const descriptor = focusAreaDescriptor(issue, issueById);
  const existing = buckets.get(descriptor.key);
  if (existing) return existing;

  const created: FocusAreaBucket = {
    key: descriptor.key,
    label: descriptor.label,
    href: descriptor.href,
    tone: "healthy",
    changedIssueIds: new Set<string>(),
    memberIssueIds: new Set<string>(),
    blockedCount: 0,
    failedRunCount: 0,
    activeAgentIds: new Set<string>(),
    latestAt: issue.updatedAt,
    latestUpdate: issue.title,
  };
  buckets.set(descriptor.key, created);
  return created;
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);

  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const recentWindowStart = new Date(now.getTime() - RECENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const [
        agentRows,
        taskRows,
        actionableApprovalRows,
        joinRequestRows,
        issueRows,
        recentIssueActivityRows,
        latestRunRows,
        completedRecentlyRows,
        monthSpendRows,
        budgetOverview,
      ] = await Promise.all([
        db
          .select({ status: agents.status, count: sql<number>`count(*)` })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .groupBy(agents.status),
        db
          .select({ status: issues.status, count: sql<number>`count(*)` })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              isNull(issues.hiddenAt),
              sql`${issues.originKind} <> 'board_copilot_thread'`,
            ),
          )
          .groupBy(issues.status),
        db
          .select({
            id: approvals.id,
            type: approvals.type,
            status: approvals.status,
            payload: approvals.payload,
            createdAt: approvals.createdAt,
            updatedAt: approvals.updatedAt,
          })
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, companyId),
              sql`${approvals.status} in ('pending', 'revision_requested')`,
            ),
          )
          .orderBy(desc(approvals.updatedAt)),
        db
          .select({
            id: joinRequests.id,
            requestType: joinRequests.requestType,
            status: joinRequests.status,
            requestEmailSnapshot: joinRequests.requestEmailSnapshot,
            agentName: joinRequests.agentName,
            createdAt: joinRequests.createdAt,
            updatedAt: joinRequests.updatedAt,
          })
          .from(joinRequests)
          .where(
            and(
              eq(joinRequests.companyId, companyId),
              eq(joinRequests.status, "pending_approval"),
            ),
          )
          .orderBy(desc(joinRequests.updatedAt)),
        db
          .select({
            id: issues.id,
            parentId: issues.parentId,
            projectId: issues.projectId,
            projectName: projects.name,
            title: issues.title,
            identifier: issues.identifier,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
            updatedAt: issues.updatedAt,
            createdAt: issues.createdAt,
          })
          .from(issues)
          .leftJoin(projects, eq(issues.projectId, projects.id))
          .where(
            and(
              eq(issues.companyId, companyId),
              isNull(issues.hiddenAt),
              sql`${issues.originKind} <> 'board_copilot_thread'`,
            ),
          ),
        db
          .select({
            issueId: activityLog.entityId,
            lastActivityAt: sql<Date>`max(${activityLog.createdAt})`,
          })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.entityType, "issue"),
              gte(activityLog.createdAt, recentWindowStart),
            ),
          )
          .groupBy(activityLog.entityId),
        db
          .selectDistinctOn([heartbeatRuns.agentId], {
            id: heartbeatRuns.id,
            agentId: heartbeatRuns.agentId,
            agentName: agents.name,
            agentStatus: agents.status,
            status: heartbeatRuns.status,
            error: heartbeatRuns.error,
            contextSnapshot: heartbeatRuns.contextSnapshot,
            createdAt: heartbeatRuns.createdAt,
            updatedAt: heartbeatRuns.updatedAt,
          })
          .from(heartbeatRuns)
          .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(agents.companyId, companyId),
              not(eq(agents.status, "terminated")),
            ),
          )
          .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt)),
        db
          .select({ count: sql<number>`count(*)` })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.status, "done"),
              isNull(issues.hiddenAt),
              gte(issues.updatedAt, recentWindowStart),
              sql`${issues.originKind} <> 'board_copilot_thread'`,
            ),
          ),
        db
          .select({
            monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          })
          .from(costEvents)
          .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart))),
        budgets.overview(companyId),
      ]);

      const pendingApprovals = actionableApprovalRows.filter((row) => row.status === "pending").length;
      const completedRecently = Number(completedRecentlyRows[0]?.count ?? 0);

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled" && row.status !== "terminated") {
          taskCounts.open += count;
        }
      }

      const monthSpendCents = Number(monthSpendRows[0]?.monthSpend ?? 0);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;

      const allIssueRows = issueRows as IssueRow[];
      const openIssueRows = allIssueRows.filter((issue) => isOpenIssueStatus(issue.status));
      const issueById = new Map(openIssueRows.map((issue) => [issue.id, issue]));
      const recentIssueActivityById = new Map<string, Date>();

      for (const row of recentIssueActivityRows as IssueActivityRow[]) {
        if (issueById.has(row.issueId)) recentIssueActivityById.set(row.issueId, row.lastActivityAt);
      }

      const focusAreaBuckets = new Map<string, FocusAreaBucket>();
      for (const issue of openIssueRows) {
        const bucket = ensureFocusArea(focusAreaBuckets, issue, issueById);
        bucket.memberIssueIds.add(issue.id);
        if (issue.status === "blocked") bucket.blockedCount += 1;
        if (issue.assigneeAgentId) bucket.activeAgentIds.add(issue.assigneeAgentId);
        if (issue.updatedAt > bucket.latestAt) {
          bucket.latestAt = issue.updatedAt;
          bucket.latestUpdate = issue.title;
        }
      }

      for (const [issueId, lastActivityAt] of recentIssueActivityById.entries()) {
        const issue = issueById.get(issueId);
        if (!issue) continue;
        const bucket = ensureFocusArea(focusAreaBuckets, issue, issueById);
        bucket.changedIssueIds.add(issueId);
        if (lastActivityAt > bucket.latestAt) {
          bucket.latestAt = lastActivityAt;
          bucket.latestUpdate = issue.title;
        }
      }

      const failedRuns = (latestRunRows as LatestRunRow[])
        .filter((row) => FAILED_RUN_STATUSES.has(row.status))
        .filter((row) => row.createdAt >= recentWindowStart)
        .filter((row) => {
          const issueId = linkedIssueId(row.contextSnapshot);
          return issueId ? issueById.has(issueId) : row.agentStatus !== "paused";
        });

      for (const run of failedRuns) {
        const issueId = linkedIssueId(run.contextSnapshot);
        if (!issueId) continue;
        const issue = issueById.get(issueId);
        if (!issue) continue;
        const bucket = ensureFocusArea(focusAreaBuckets, issue, issueById);
        bucket.failedRunCount += 1;
        if (run.createdAt > bucket.latestAt) {
          bucket.latestAt = run.createdAt;
          bucket.latestUpdate = `${run.agentName} ${run.status.replace("_", " ")}`;
        }
      }

      for (const approval of actionableApprovalRows) {
        const issueId = linkedApprovalIssueId(approval.payload);
        if (issueId && issueById.has(issueId)) {
          const bucket = ensureFocusArea(focusAreaBuckets, issueById.get(issueId)!, issueById);
          if (approval.updatedAt > bucket.latestAt) {
            bucket.latestAt = approval.updatedAt;
            bucket.latestUpdate = approvalTitle(approval);
          }
          continue;
        }

        const projectId = linkedProjectId(approval.payload);
        if (!projectId) continue;
        const issue = openIssueRows.find((row) => row.projectId === projectId);
        if (!issue) continue;
        const bucket = ensureFocusArea(focusAreaBuckets, issue, issueById);
        if (approval.updatedAt > bucket.latestAt) {
          bucket.latestAt = approval.updatedAt;
          bucket.latestUpdate = approvalTitle(approval);
        }
      }

      const issueAttentionItems: DashboardAttentionItem[] = [];
      for (const issue of openIssueRows) {
        const lastActivityAt = recentIssueActivityById.get(issue.id);
        if (!lastActivityAt) continue;

        const isBlocked = issue.status === "blocked";
        const isUnassigned = !issue.assigneeAgentId && !issue.assigneeUserId;
        const isWaitingOnBoard = !!issue.assigneeUserId;

        if (!isBlocked && !isUnassigned && !isWaitingOnBoard) continue;

        let reason = "Needs routing";
        let severity: DashboardAttentionItem["severity"] = "medium";

        if (isBlocked) {
          reason = "Blocked issue with new activity";
          severity = "high";
        } else if (isWaitingOnBoard) {
          reason = "Waiting on board action";
          severity = "high";
        } else if (isUnassigned) {
          reason = "Unassigned issue with new activity";
          severity = "medium";
        }

        issueAttentionItems.push({
          key: `issue:${issue.id}`,
          kind: "issue",
          entityId: issue.id,
          title: issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title,
          reason,
          severity,
          timestamp: lastActivityAt,
          href: `/issues/${issue.identifier ?? issue.id}`,
          ctaLabel: "Open issue",
        });
      }

      const approvalAttentionItems: DashboardAttentionItem[] = actionableApprovalRows.map((approval) => ({
        key: `approval:${approval.id}`,
        kind: "approval",
        entityId: approval.id,
        title: approvalTitle(approval),
        reason:
          approval.status === "revision_requested"
            ? "Revision requested before approval"
            : "Pending board approval",
        severity:
          approval.status === "revision_requested"
            ? "high"
            : "medium",
        timestamp: approval.updatedAt,
        href: `/approvals/${approval.id}`,
        ctaLabel: "Review approval",
      }));

      const joinRequestAttentionItems: DashboardAttentionItem[] = joinRequestRows.map((joinRequest) => ({
        key: `join_request:${joinRequest.id}`,
        kind: "join_request",
        entityId: joinRequest.id,
        title: joinRequestTitle(joinRequest),
        reason: "Pending join request",
        severity: "medium",
        timestamp: joinRequest.updatedAt,
        href: "/inbox/unread",
        ctaLabel: "Review request",
      }));

      const failedRunAttentionItems: DashboardAttentionItem[] = failedRuns.map((run) => {
        const linkedId = linkedIssueId(run.contextSnapshot);
        const linkedIssue = linkedId ? issueById.get(linkedId) ?? null : null;
        const issueRef = linkedIssue?.identifier ?? linkedIssue?.id;
        return {
          key: `run:${run.id}`,
          kind: "run",
          entityId: run.id,
          title: issueRef
            ? `${run.agentName} failed on ${issueRef} ${linkedIssue?.title ?? ""}`.trim()
            : `${run.agentName} ${run.status.replace("_", " ")}`,
          reason: "Failed active run",
          severity: "high",
          timestamp: run.createdAt,
          href: `/agents/${run.agentId}/runs/${run.id}`,
          ctaLabel: "Inspect failure",
        };
      });

      const attentionItems: DashboardAttentionItem[] = [
        ...approvalAttentionItems,
        ...joinRequestAttentionItems,
        ...failedRunAttentionItems,
        ...issueAttentionItems,
      ]
        .sort((a, b) => {
          const priorityDiff = attentionPriority(a.kind) - attentionPriority(b.kind);
          if (priorityDiff !== 0) return priorityDiff;
          const severityDiff = severityRank(b.severity) - severityRank(a.severity);
          if (severityDiff !== 0) return severityDiff;
          return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        })
        .slice(0, 7);

      const decisionsCount =
        actionableApprovalRows.length +
        joinRequestRows.length +
        issueAttentionItems.filter((item) => item.reason === "Waiting on board action").length;

      const briefHealth = resolveDashboardHealth({
        blockedIssues: taskCounts.blocked,
        failedRuns: failedRuns.length,
        activeBudgetIncidents: budgetOverview.activeIncidents.length,
        decisions: decisionsCount,
        agentErrors: agentCounts.error,
        utilizationPercent: utilization,
      });

      const focusAreas = Array.from(focusAreaBuckets.values())
        .filter((bucket) => bucket.changedIssueIds.size > 0 || bucket.failedRunCount > 0)
        .map((bucket) => {
          const tone: DashboardBriefTone =
            bucket.blockedCount > 0
              ? "blocked"
              : bucket.failedRunCount > 0
                ? "at_risk"
                : bucket.changedIssueIds.size >= 3
                  ? "watch"
                  : "healthy";

          return {
            key: bucket.key,
            label: bucket.label,
            tone,
            changedIssueCount: bucket.changedIssueIds.size,
            blockedCount: bucket.blockedCount,
            failedRunCount: bucket.failedRunCount,
            activeAgentCount: bucket.activeAgentIds.size,
            latestUpdate: bucket.latestUpdate,
            href: bucket.href,
            latestAt: bucket.latestAt,
          };
        })
        .sort((a, b) => {
          const toneDiff = toneRank(b.tone) - toneRank(a.tone);
          if (toneDiff !== 0) return toneDiff;
          return b.latestAt.getTime() - a.latestAt.getTime();
        })
        .slice(0, 5)
        .map(({ latestAt: _latestAt, ...bucket }) => bucket);

      const spendHeadline =
        company.budgetMonthlyCents > 0
          ? utilization >= 100
            ? "Budget limit reached"
            : utilization >= 80
              ? "Budget is getting tight"
              : "Budget is under control"
          : "No monthly budget cap";

      const progressHeadline =
        taskCounts.inProgress > 0
          ? "Work is moving"
          : taskCounts.open > 0
            ? "Work is queued but not yet moving"
            : "No active work in flight";

      const riskHeadline =
        taskCounts.blocked > 0
          ? "Blocked work needs intervention"
          : failedRuns.length > 0
            ? "Execution reliability needs attention"
            : "No critical execution risk right now";

      const decisionsHeadline =
        decisionsCount > 0 ? "Board input required" : "No board decisions waiting";

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        brief: {
          health: briefHealth,
          snapshot: {
            progress: {
              value: String(taskCounts.inProgress),
              label: "In flight",
              headline: progressHeadline,
              detail: `${pluralize(completedRecently, "issue")} completed in the last ${RECENT_ACTIVITY_WINDOW_DAYS} days`,
              tone: taskCounts.inProgress > 0 ? "healthy" : taskCounts.open > 0 ? "watch" : "healthy",
            },
            risk: {
              value: String(taskCounts.blocked),
              label: "Blocked",
              headline: riskHeadline,
              detail: `${pluralize(failedRuns.length, "failed run")} on active work`,
              tone: taskCounts.blocked > 0 ? "blocked" : failedRuns.length > 0 ? "at_risk" : "healthy",
            },
            decisions: {
              value: String(decisionsCount),
              label: "Waiting",
              headline: decisionsHeadline,
              detail: `${pluralize(actionableApprovalRows.length, "approval")}, ${pluralize(joinRequestRows.length, "join request")}, ${pluralize(issueAttentionItems.filter((item) => item.reason === "Waiting on board action").length, "board-owned issue")}`,
              tone: decisionsCount > 0 ? "watch" : "healthy",
            },
            spend: {
              value: formatUsdCents(monthSpendCents),
              label: "Month spend",
              headline: spendHeadline,
              detail:
                company.budgetMonthlyCents > 0
                  ? `${Number(utilization.toFixed(2))}% of ${formatUsdCents(company.budgetMonthlyCents)} budget`
                  : "Unlimited budget",
              tone:
                budgetOverview.activeIncidents.length > 0
                  ? "blocked"
                  : utilization >= 80
                    ? "watch"
                    : "healthy",
            },
          },
          focusAreas,
          needsAttention: attentionItems,
        },
      };
    },
  };
}
