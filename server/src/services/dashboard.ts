import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  companies,
  costEvents,
  heartbeatRuns,
  issueComments,
  issues,
  labels,
  projectLabels,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import type { CostByProject, DashboardCodexProjectsEstimate } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { costService } from "./costs.js";

const DASHBOARD_ACTIVITY_LIMIT = 10;
const DASHBOARD_LIVE_RUN_LIMIT = 10;
const DASHBOARD_STALE_ISSUE_LIMIT = 10;
const DASHBOARD_STALE_ISSUE_WINDOW_MS = 45 * 60 * 1000;
const DASHBOARD_CODEX_PROJECT_ESTIMATE_WINDOW_DAYS = 7;
const DASHBOARD_CODEX_PROJECT_DEV_HOURS_PER_PROJECT_WEEK = 1;
const CODEX_PROJECT_LABEL_NAME = "Codex";
const CODEX_PROJECT_SYNC_SOURCE = "codex_project_sync";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CODEX_PROJECT_ESTIMATE_ASSUMPTION =
  "Estimated from active project-weeks for current Codex-labeled or Codex-synced projects over the last 7 days. One active project-week is treated as 1 developer hour at the company's developer value rate; tracked tokens are shown as supporting evidence only. This is not billed spend.";

const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const STALE_ISSUE_PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function maxDate(dates: Array<Date | null | undefined>) {
  let latest: Date | null = null;
  for (const date of dates) {
    if (!date) continue;
    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function priorityRank(priority: string | null | undefined) {
  if (!priority) return Number.MAX_SAFE_INTEGER;
  return STALE_ISSUE_PRIORITY_RANK[priority] ?? Number.MAX_SAFE_INTEGER;
}

function roundTo(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function currentProjectWindowDays(input: {
  createdAt: Date | string | number | null | undefined;
  windowStart: Date;
  windowEnd: Date;
}) {
  const createdAt = asDate(input.createdAt) ?? input.windowStart;
  const startMs = Math.max(createdAt.getTime(), input.windowStart.getTime());
  const endMs = input.windowEnd.getTime();
  if (startMs >= endMs) return 0;
  return (endMs - startMs) / MS_PER_DAY;
}

export function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

function currentCodexEstimateWindow(now: Date) {
  return {
    start: new Date(now.getTime() - DASHBOARD_CODEX_PROJECT_ESTIMATE_WINDOW_DAYS * MS_PER_DAY),
    end: now,
  };
}

function buildCodexProjectsEstimate(input: {
  projects: Array<{ id: string; status: string; createdAt: Date }>;
  projectCosts: CostByProject[];
  windowStart: Date;
  windowEnd: Date;
  devValueHourlyRateCents: number;
  devValueTokensPerHour: number;
}): DashboardCodexProjectsEstimate {
  const currentProjects = input.projects.filter((project) =>
    project.status !== "completed" && project.status !== "cancelled",
  );
  const projectIds = new Set(currentProjects.map((project) => project.id));
  const relevantCosts = input.projectCosts.filter((row) => row.projectId && projectIds.has(row.projectId));

  const inputTokens = relevantCosts.reduce((sum, row) => sum + row.inputTokens, 0);
  const cachedInputTokens = relevantCosts.reduce((sum, row) => sum + row.cachedInputTokens, 0);
  const outputTokens = relevantCosts.reduce((sum, row) => sum + row.outputTokens, 0);
  const totalTokens = inputTokens + cachedInputTokens + outputTokens;
  const devValueTokensPerHour = Math.max(1, input.devValueTokensPerHour);
  const devValueHourlyRateCents = Math.max(0, input.devValueHourlyRateCents);
  const trackedTokenDevHours = totalTokens / devValueTokensPerHour;
  const activeProjectDays = currentProjects.reduce(
    (sum, project) => sum + currentProjectWindowDays({
      createdAt: project.createdAt,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    }),
    0,
  );
  const projectWeekEquivalent = activeProjectDays / DASHBOARD_CODEX_PROJECT_ESTIMATE_WINDOW_DAYS;
  const estimatedDevHours = projectWeekEquivalent * DASHBOARD_CODEX_PROJECT_DEV_HOURS_PER_PROJECT_WEEK;

  return {
    labelName: CODEX_PROJECT_LABEL_NAME,
    windowDays: DASHBOARD_CODEX_PROJECT_ESTIMATE_WINDOW_DAYS,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    projectCount: currentProjects.length,
    activeProjectDays: roundTo(activeProjectDays, 2),
    projectWeekEquivalent: roundTo(projectWeekEquivalent, 2),
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    estimatedDevHours: roundTo(estimatedDevHours, 2),
    estimatedDevValueCents: Math.round(estimatedDevHours * devValueHourlyRateCents),
    trackedTokenDevHours: roundTo(trackedTokenDevHours, 2),
    devValueHourlyRateCents,
    devValueTokensPerHour,
    devHoursPerProjectWeek: DASHBOARD_CODEX_PROJECT_DEV_HOURS_PER_PROJECT_WEEK,
    assumption: CODEX_PROJECT_ESTIMATE_ASSUMPTION,
  };
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  const costs = costService(db);
  const issueIdAsText = sql<string>`${issues.id}::text`;
  return {
    summary: async (companyId: string, now = new Date()) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const latestCommentPerIssue = db
        .select({
          issueId: issueComments.issueId,
          latestCommentAt: sql<Date | null>`max(${issueComments.createdAt})`.as("latest_comment_at"),
        })
        .from(issueComments)
        .where(eq(issueComments.companyId, companyId))
        .groupBy(issueComments.issueId)
        .as("latest_comment_per_issue");

      const latestActivityPerIssue = db
        .select({
          issueId: activityLog.entityId,
          latestActivityAt: sql<Date | null>`max(${activityLog.createdAt})`.as("latest_activity_at"),
        })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue")))
        .groupBy(activityLog.entityId)
        .as("latest_activity_per_issue");

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };

      const { start: monthStart, end: monthEnd } = currentUtcMonthWindow(now);
      const { start: codexEstimateStart, end: codexEstimateEnd } = currentCodexEstimateWindow(now);
      const [
        agentRows,
        taskRows,
        pendingApprovals,
        [{ monthSpend }],
        allLiveRuns,
        recentActivity,
        staleIssueCandidates,
        budgetOverview,
        workValue,
        codexProjectRows,
        codexProjectCostRows,
      ] = await Promise.all([
        db
          .select({ status: agents.status, count: sql<number>`count(*)` })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .groupBy(agents.status),
        db
          .select({ status: issues.status, count: sql<number>`count(*)` })
          .from(issues)
          .where(eq(issues.companyId, companyId))
          .groupBy(issues.status),
        db
          .select({ count: sql<number>`count(*)` })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
          .then((rows) => Number(rows[0]?.count ?? 0)),
        db
          .select({
            monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.companyId, companyId),
              gte(costEvents.occurredAt, monthStart),
              lt(costEvents.occurredAt, monthEnd),
            ),
          ),
        db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
            invocationSource: heartbeatRuns.invocationSource,
            triggerDetail: heartbeatRuns.triggerDetail,
            startedAt: heartbeatRuns.startedAt,
            finishedAt: heartbeatRuns.finishedAt,
            createdAt: heartbeatRuns.createdAt,
            agentId: heartbeatRuns.agentId,
            agentName: agents.name,
            adapterType: agents.adapterType,
            issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
          })
          .from(heartbeatRuns)
          .innerJoin(
            agents,
            and(
              eq(heartbeatRuns.agentId, agents.id),
              eq(heartbeatRuns.companyId, agents.companyId),
            ),
          )
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
            ),
          )
          .orderBy(desc(heartbeatRuns.createdAt)),
        db
          .select({
            id: activityLog.id,
            companyId: activityLog.companyId,
            actorType: activityLog.actorType,
            actorId: activityLog.actorId,
            action: activityLog.action,
            entityType: activityLog.entityType,
            entityId: activityLog.entityId,
            agentId: activityLog.agentId,
            runId: activityLog.runId,
            details: activityLog.details,
            createdAt: activityLog.createdAt,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
          })
          .from(activityLog)
          .leftJoin(
            issues,
            and(
              eq(activityLog.entityType, sql`'issue'`),
              eq(activityLog.entityId, issueIdAsText),
            ),
          )
          .where(
            and(
              eq(activityLog.companyId, companyId),
              or(
                sql`${activityLog.entityType} != 'issue'`,
                isNull(issues.hiddenAt),
              ),
            ),
          )
          .orderBy(desc(activityLog.createdAt))
          .limit(DASHBOARD_ACTIVITY_LIMIT),
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
            updatedAt: issues.updatedAt,
            latestCommentAt: latestCommentPerIssue.latestCommentAt,
            latestActivityAt: latestActivityPerIssue.latestActivityAt,
          })
          .from(issues)
          .leftJoin(latestCommentPerIssue, eq(issues.id, latestCommentPerIssue.issueId))
          .leftJoin(latestActivityPerIssue, sql`${issues.id}::text = ${latestActivityPerIssue.issueId}`)
          .where(
            and(
              eq(issues.companyId, companyId),
              isNull(issues.hiddenAt),
              inArray(issues.status, ["blocked", "in_progress"]),
            ),
          ),
        budgets.overview(companyId),
        costs.workValue(companyId, { from: monthStart, to: monthEnd }),
        db
          .selectDistinctOn([projects.id], {
            id: projects.id,
            status: projects.status,
            createdAt: projects.createdAt,
          })
          .from(projects)
          .leftJoin(
            projectLabels,
            and(
              eq(projectLabels.projectId, projects.id),
              eq(projectLabels.companyId, companyId),
            ),
          )
          .leftJoin(
            labels,
            and(
              eq(labels.id, projectLabels.labelId),
              eq(labels.companyId, companyId),
            ),
          )
          .leftJoin(
            projectWorkspaces,
            and(
              eq(projectWorkspaces.projectId, projects.id),
              eq(projectWorkspaces.companyId, companyId),
            ),
          )
          .where(
            and(
              eq(projects.companyId, companyId),
              isNull(projects.archivedAt),
              or(
                sql`lower(${labels.name}) = ${CODEX_PROJECT_LABEL_NAME.toLowerCase()}`,
                sql`${projectWorkspaces.metadata} ->> 'source' = ${CODEX_PROJECT_SYNC_SOURCE}`,
              ),
            ),
          )
          .orderBy(projects.id),
        costs.byProject(companyId, { from: codexEstimateStart, to: codexEstimateEnd }),
      ]);
      const codexProjectsEstimate = buildCodexProjectsEstimate({
        projects: codexProjectRows,
        projectCosts: codexProjectCostRows,
        windowStart: codexEstimateStart,
        windowEnd: codexEstimateEnd,
        devValueHourlyRateCents: workValue.devValueHourlyRateCents,
        devValueTokensPerHour: workValue.devValueTokensPerHour,
      });

      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const monthSpendCents = Number(monthSpend);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const staleCutoff = new Date(now.getTime() - DASHBOARD_STALE_ISSUE_WINDOW_MS);
      const activeRunByIssueId = new Map<string, typeof allLiveRuns[number]>();
      for (const run of allLiveRuns) {
        if (!run.issueId || activeRunByIssueId.has(run.issueId)) continue;
        activeRunByIssueId.set(run.issueId, run);
      }

      const staleIssues = staleIssueCandidates
        .map((issue) => {
          const activeRun = activeRunByIssueId.get(issue.id);
          const lastMovementAt = maxDate([
            asDate(issue.updatedAt),
            asDate(issue.latestCommentAt),
            asDate(issue.latestActivityAt),
          ]) ?? asDate(issue.updatedAt) ?? now;
          const staleReason =
            issue.status === "blocked"
              ? "blocked"
              : issue.status === "in_progress" && !activeRun && lastMovementAt.getTime() <= staleCutoff.getTime()
                ? "inactive"
                : null;
          if (!staleReason) return null;
          return {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
            assigneeAgentId: issue.assigneeAgentId,
            assigneeUserId: issue.assigneeUserId,
            staleReason,
            updatedAt: asDate(issue.updatedAt) ?? now,
            latestCommentAt: asDate(issue.latestCommentAt),
            latestActivityAt: asDate(issue.latestActivityAt),
            lastMovementAt,
            activeRunId: activeRun?.id ?? null,
          };
        })
        .filter((issue): issue is NonNullable<typeof issue> => issue !== null)
        .sort((left, right) => {
          if (left.staleReason !== right.staleReason) {
            return left.staleReason === "blocked" ? -1 : 1;
          }
          const priorityDiff = priorityRank(left.priority) - priorityRank(right.priority);
          if (priorityDiff !== 0) return priorityDiff;
          return left.lastMovementAt.getTime() - right.lastMovementAt.getTime();
        })
        .slice(0, DASHBOARD_STALE_ISSUE_LIMIT);

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
          workValue,
          codexProjectsEstimate,
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        staleIssues,
        recentActivity,
        liveRuns: allLiveRuns.slice(0, DASHBOARD_LIVE_RUN_LIMIT),
      };
    },
  };
}
