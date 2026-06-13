import { and, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { ISSUE_PRIORITIES, ISSUE_STATUSES, type IssuePriority, type IssueStatus } from "@paperclipai/shared";
import type { DashboardIssueActivityDay, DashboardRecentIssue } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import {
  computeAgentScorecards,
  MIN_SAMPLE_DONE,
  MIN_SAMPLE_RUNS,
  MIN_SAMPLE_REVIEWS,
  TERMINAL_RUN_STATUSES,
  type AgentScorecardInput,
  type AgentRunCounts,
  type AgentReviewCounts,
} from "./agent-scorecards.js";

const DASHBOARD_SCORECARD_DEFAULT_WINDOW_DAYS = 30;
const DASHBOARD_SCORECARD_MAX_WINDOW_DAYS = 365;
// Agent statuses excluded from the staffing scorecard roster (no longer
// staffable / not yet hired).
const SCORECARD_EXCLUDED_AGENT_STATUSES = ["terminated", "pending_approval"];

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;
const DASHBOARD_ISSUE_ACTIVITY_DAYS = 14;
// Top N issues by lastActivityAt. Drives the Recent Issues panel (renders
// the first 10) AND the activity-feed entityName/entityTitle lookup map
// (covers issues referenced by the 10 latest activity events).
const DASHBOARD_RECENT_ISSUE_LIMIT = 50;

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

function emptyPriorityBuckets(): Record<IssuePriority, number> {
  return Object.fromEntries(ISSUE_PRIORITIES.map((p) => [p, 0])) as Record<IssuePriority, number>;
}

function emptyStatusBuckets(): Record<IssueStatus, number> {
  return Object.fromEntries(ISSUE_STATUSES.map((s) => [s, 0])) as Record<IssueStatus, number>;
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);

  // Cheap aggregates the sidebar-badges polling path needs (agent status,
  // task counts, costs, pending approvals, run activity). Split out so
  // sidebar-badges (polled ~every 15 s on every page) doesn't pay for the
  // GROUP BY-on-issues queries that summary() adds.
  async function core(companyId: string) {
    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    if (!company) throw notFound("Company not found");

    const agentRows = await db
      .select({ status: agents.status, count: sql<number>`count(*)` })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .groupBy(agents.status);

    const taskRows = await db
      .select({ status: issues.status, count: sql<number>`count(*)` })
      .from(issues)
      .where(eq(issues.companyId, companyId))
      .groupBy(issues.status);

    const pendingApprovals = await db
      .select({ count: sql<number>`count(*)` })
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
      .then((rows) => Number(rows[0]?.count ?? 0));

    const agentCounts: Record<string, number> = {
      active: 0,
      running: 0,
      paused: 0,
      error: 0,
    };
    for (const row of agentRows) {
      const count = Number(row.count);
      // "idle" agents are operational — count them as active
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
      if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
    }

    const now = new Date();
    const monthStart = getUtcMonthStart(now);
    const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
    const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
    const [{ monthSpend }] = await db
      .select({
        monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.occurredAt, monthStart),
        ),
      );

    const monthSpendCents = Number(monthSpend);
    const runActivityDayExpr = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const runActivityRows = await db
      .select({
        date: runActivityDayExpr,
        status: heartbeatRuns.status,
        count: sql<number>`count(*)::double precision`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          gte(heartbeatRuns.createdAt, runActivityStart),
        ),
      )
      .groupBy(runActivityDayExpr, heartbeatRuns.status);

    const runActivity = new Map(
      runActivityDays.map((date) => [
        date,
        { date, succeeded: 0, failed: 0, other: 0, total: 0 },
      ]),
    );
    for (const row of runActivityRows) {
      const bucket = runActivity.get(row.date);
      if (!bucket) {
        logger.warn({ companyId, unmappedDate: row.date }, "dashboard runActivity received row outside the precomputed day window");
        continue;
      }
      const count = Number(row.count);
      if (row.status === "succeeded") bucket.succeeded += count;
      else if (row.status === "failed" || row.status === "timed_out") bucket.failed += count;
      else bucket.other += count;
      bucket.total += count;
    }

    const utilization =
      company.budgetMonthlyCents > 0
        ? (monthSpendCents / company.budgetMonthlyCents) * 100
        : 0;
    const budgetOverview = await budgets.overview(companyId);

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
      runActivity: Array.from(runActivity.values()),
      // Date window the issue-activity portion of summary() will cover.
      // Reused so summary() doesn't recompute the keys / start timestamp.
      _issueActivityWindow: { days: getRecentUtcDateKeys(now, DASHBOARD_ISSUE_ACTIVITY_DAYS) },
    } as const;
  }

  // Full dashboard payload: core() plus per-day issue creation breakdown
  // (priority + status) and the top-N most-recently-active issues used by
  // the Recent Issues panel and the activity-feed entityName lookup map.
  // Server-side aggregation here avoids shipping the full company issue
  // list to the client just to bin by createdAt-day. Relies on the
  // (company_id, created_at) and (company_id, last_activity_at) indexes.
  async function summary(companyId: string) {
    const base = await core(companyId);
    const issueActivityDays = base._issueActivityWindow.days;
    const issueActivityStart = new Date(`${issueActivityDays[0]}T00:00:00.000Z`);
    const issueDayExpr = sql<string>`to_char(${issues.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

    const [issuePriorityRows, issueStatusRows, recentIssuesRows] = await Promise.all([
      db
        .select({
          date: issueDayExpr,
          priority: issues.priority,
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          gte(issues.createdAt, issueActivityStart),
          isNull(issues.hiddenAt),
        ))
        .groupBy(issueDayExpr, issues.priority),
      db
        .select({
          date: issueDayExpr,
          status: issues.status,
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          gte(issues.createdAt, issueActivityStart),
          isNull(issues.hiddenAt),
        ))
        .groupBy(issueDayExpr, issues.status),
      db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          projectId: issues.projectId,
          parentId: issues.parentId,
          assigneeAgentId: issues.assigneeAgentId,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
          lastActivityAt: issues.lastActivityAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
        // lastActivityAt (not updatedAt) so the lookup map covers issues
        // referenced by recent comment / heartbeat activity even when the
        // issues row itself wasn't touched. The column has a (company_id,
        // last_activity_at) index, kept up to date by the activity-log
        // triggers in migration 0072.
        .orderBy(desc(issues.lastActivityAt))
        .limit(DASHBOARD_RECENT_ISSUE_LIMIT),
    ]);

    const issueActivity: DashboardIssueActivityDay[] = issueActivityDays.map((date) => ({
      date,
      total: 0,
      byPriority: emptyPriorityBuckets(),
      byStatus: emptyStatusBuckets(),
    }));
    const issueActivityByDate = new Map(issueActivity.map((day) => [day.date, day]));
    for (const row of issuePriorityRows) {
      const bucket = issueActivityByDate.get(row.date);
      if (!bucket) {
        logger.warn({ companyId, unmappedDate: row.date, axis: "priority" }, "dashboard issueActivity received row outside the precomputed day window");
        continue;
      }
      const priority = row.priority as IssuePriority;
      if (!(priority in bucket.byPriority)) {
        logger.warn({ companyId, unknownPriority: row.priority }, "dashboard issueActivity skipped row with non-canonical priority");
        continue;
      }
      bucket.byPriority[priority] += Number(row.count);
    }
    for (const row of issueStatusRows) {
      const bucket = issueActivityByDate.get(row.date);
      if (!bucket) {
        logger.warn({ companyId, unmappedDate: row.date, axis: "status" }, "dashboard issueActivity received row outside the precomputed day window");
        continue;
      }
      const status = row.status as IssueStatus;
      if (!(status in bucket.byStatus)) {
        logger.warn({ companyId, unknownStatus: row.status }, "dashboard issueActivity skipped row with non-canonical status");
        continue;
      }
      bucket.byStatus[status] += Number(row.count);
    }
    // Derive total from byPriority post-loop. Every issue has exactly one
    // priority and one status, so byPriority and byStatus partition the
    // same set; either one yields the same total. Computing once instead
    // of incrementing inside both loops removes the asymmetric-update
    // footgun (priority loop owned `total`, status loop didn't).
    for (const day of issueActivity) {
      day.total = Object.values(day.byPriority).reduce((sum, n) => sum + n, 0);
    }

    // Strip the internal window field that core() carried over for reuse.
    const { _issueActivityWindow, ...rest } = base;
    return {
      ...rest,
      issueActivity,
      recentIssues: recentIssuesRows as DashboardRecentIssue[],
    };
  }

  // Agent scorecard feed for the monthly staffing routine (BLO-10275). Runs
  // four grouped-by-agent aggregates over the window and merges them through
  // the pure `computeAgentScorecards` helper (unit-tested separately).
  //
  // Attribution: issue-derived signals (done count, review verdict) are
  // credited to the IMPLEMENTER, not the live `issues.assignee_agent_id`.
  // Execution-policy review/approval stages reassign the issue to the
  // reviewer/approver while it is in review and can leave it assigned there
  // at `done`, so grouping by the current assignee would credit the reviewer.
  // `executionState.returnAssignee` is the immutable principal the work
  // returns to; we prefer it and fall back to the assignee only for issues
  // that never entered a review stage. See `implementerAgentExpr` below.
  //
  // Relies on the cost_events (company, agent, occurred), issues
  // (company, status), issues (company, last_evidence_verdict_evaluated_at),
  // and heartbeat_runs (company, agent, started) indexes.
  async function agentScorecards(companyId: string, options?: { windowDays?: number }) {
    const company = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");

    const windowDays = Math.min(
      Math.max(1, Math.floor(options?.windowDays ?? DASHBOARD_SCORECARD_DEFAULT_WINDOW_DAYS)),
      DASHBOARD_SCORECARD_MAX_WINDOW_DAYS,
    );
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const windowStartIso = windowStart.toISOString();

    const verdictExpr = sql<string>`${issues.lastEvidenceVerdict} ->> 'verdict'`;
    // Immutable implementer: prefer executionState.returnAssignee when it
    // names an agent (the worker the review path returns to), else the current
    // assignee (issues with no execution policy never get a returnAssignee).
    // Cast assignee_agent_id to text so the COALESCE branches share a type and
    // match the text agent ids the JSONB path yields.
    const implementerAgentExpr = sql<string | null>`coalesce(
      case
        when ${issues.executionState} #>> '{returnAssignee,type}' = 'agent'
          then ${issues.executionState} #>> '{returnAssignee,agentId}'
        else null
      end,
      ${issues.assigneeAgentId}::text
    )`;
    const [agentRows, doneRows, costRows, runRows, reviewRows] = await Promise.all([
      db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            notInArray(agents.status, SCORECARD_EXCLUDED_AGENT_STATUSES),
          ),
        ),
      db
        .select({ agentId: implementerAgentExpr, count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            gte(issues.completedAt, windowStart),
          ),
        )
        .groupBy(implementerAgentExpr),
      db
        .select({
          agentId: costEvents.agentId,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, windowStart)))
        .groupBy(costEvents.agentId),
      db
        .select({
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          count: sql<number>`count(*)::int`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            // Terminal statuses only, filtered in SQL so non-terminal rows
            // (queued / running / scheduled_retry) are never grouped just to be
            // discarded in TS. Windowed on started_at — the time column carried
            // by the (company_id, agent_id, started_at) index — rather than
            // created_at, whose only composite index sits behind liveness_state
            // and so can't serve this scan as run history grows. A run cancelled
            // while still queued has a null started_at and drops out here, which
            // is correct: no execution happened and cancelled runs sit outside
            // the failure-rate denominator anyway.
            inArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES),
            gte(heartbeatRuns.startedAt, windowStart),
          ),
        )
        .groupBy(heartbeatRuns.agentId, heartbeatRuns.status),
      db
        .select({ agentId: implementerAgentExpr, verdict: verdictExpr, count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            sql`${issues.lastEvidenceVerdict} is not null`,
            gte(issues.lastEvidenceVerdictEvaluatedAt, windowStart),
          ),
        )
        .groupBy(implementerAgentExpr, verdictExpr),
    ]);

    const doneByAgent = new Map<string, number>();
    for (const row of doneRows) {
      if (row.agentId) doneByAgent.set(row.agentId, Number(row.count));
    }
    const costByAgent = new Map<string, number>();
    for (const row of costRows) {
      if (row.agentId) costByAgent.set(row.agentId, Number(row.costCents));
    }
    const runsByAgent = new Map<string, AgentRunCounts>();
    for (const row of runRows) {
      if (!row.agentId) continue;
      const bucket =
        runsByAgent.get(row.agentId) ??
        ({ succeeded: 0, failed: 0, timedOut: 0, cancelled: 0 } satisfies AgentRunCounts);
      const count = Number(row.count);
      if (row.status === "succeeded") bucket.succeeded += count;
      else if (row.status === "failed") bucket.failed += count;
      else if (row.status === "timed_out") bucket.timedOut += count;
      else if (row.status === "cancelled") bucket.cancelled += count;
      // Non-terminal statuses are already excluded by the SQL where-clause.
      runsByAgent.set(row.agentId, bucket);
    }
    const reviewsByAgent = new Map<string, AgentReviewCounts>();
    for (const row of reviewRows) {
      if (!row.agentId) continue;
      const bucket =
        reviewsByAgent.get(row.agentId) ?? ({ pass: 0, warn: 0, block: 0 } satisfies AgentReviewCounts);
      const count = Number(row.count);
      if (row.verdict === "pass") bucket.pass += count;
      else if (row.verdict === "warn") bucket.warn += count;
      else if (row.verdict === "block") bucket.block += count;
      reviewsByAgent.set(row.agentId, bucket);
    }

    const inputs: AgentScorecardInput[] = agentRows.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      status: agent.status as AgentScorecardInput["status"],
      doneIssues: doneByAgent.get(agent.id) ?? 0,
      costCents: costByAgent.get(agent.id) ?? 0,
      runs: runsByAgent.get(agent.id) ?? { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0 },
      reviews: reviewsByAgent.get(agent.id) ?? { pass: 0, warn: 0, block: 0 },
    }));

    return computeAgentScorecards(inputs, {
      windowDays,
      windowStart: windowStartIso,
      windowEnd: now.toISOString(),
      generatedAt: now.toISOString(),
      minSampleDone: MIN_SAMPLE_DONE,
      minSampleRuns: MIN_SAMPLE_RUNS,
      minSampleReviews: MIN_SAMPLE_REVIEWS,
    });
  }

  return {
    core,
    summary,
    agentScorecards,
  };
}
