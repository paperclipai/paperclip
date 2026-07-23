import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  costEvents,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { visibleIssueCondition } from "./issue-visibility.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;

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

export type LastRunOutcome = "succeeded" | "failed" | "error" | "none";
export type QuiescenceMode = "A" | "A_prime" | "B1" | "B2" | "unknown";

export interface AgentStatusEntry {
  agentId: string;
  name: string;
  status: string;
  lastRunOutcome: LastRunOutcome;
  quietSince: string | null;
  quietForMs: number | null;
  quiescenceMode: QuiescenceMode;
  blockersOpen: number;
}

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

function mapRunStatusToOutcome(status: string | null | undefined): LastRunOutcome {
  if (!status) return "none";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "error" || status === "crashed" || status === "timeout") return "error";
  return "none";
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

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), visibleIssueCondition()))
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
      // Per-day run breakdown. A run is "recovered" when its retry chain later
      // succeeded (recovered_runs = all ancestors of a succeeded retry), so a
      // restart-killed run whose retry succeeded is pulled out of the headline
      // failed count. error_code is carried through so a failure spike can be
      // attributed to an error class (e.g. process_lost, provider_quota).
      const runActivityRows = (await db.execute(sql`
        WITH RECURSIVE recovered_runs(id) AS (
          SELECT parent.id
          FROM ${heartbeatRuns} AS child
          JOIN ${heartbeatRuns} AS parent ON parent.id = child.retry_of_run_id
          WHERE child.company_id = ${companyId}
            AND child.status = 'succeeded'
          UNION
          SELECT parent.id
          FROM recovered_runs rr
          JOIN ${heartbeatRuns} AS child ON child.id = rr.id
          JOIN ${heartbeatRuns} AS parent ON parent.id = child.retry_of_run_id
        )
        SELECT
          to_char(run.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
          run.status AS status,
          run.error_code AS error_code,
          (run.id IN (SELECT id FROM recovered_runs)) AS recovered,
          count(*)::double precision AS count
        FROM ${heartbeatRuns} AS run
        WHERE run.company_id = ${companyId}
          AND run.created_at >= ${runActivityStart.toISOString()}::timestamptz
        GROUP BY date, run.status, run.error_code, recovered
      `)) as unknown as Iterable<{
        date: string;
        status: string;
        error_code: string | null;
        recovered: boolean | string;
        count: number | string;
      }>;

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          {
            date,
            succeeded: 0,
            failed: 0,
            recovered: 0,
            other: 0,
            total: 0,
            failedByErrorCode: {} as Record<string, number>,
          },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(String(row.date));
        if (!bucket) continue;
        const count = Number(row.count);
        const status = String(row.status);
        // Postgres booleans can arrive as JS boolean or "t"/"true" depending on driver.
        const recovered = row.recovered === true || row.recovered === "t" || row.recovered === "true";
        if (status === "succeeded") {
          bucket.succeeded += count;
        } else if (status === "failed" || status === "timed_out") {
          if (recovered) {
            bucket.recovered += count;
          } else {
            bucket.failed += count;
            const code =
              typeof row.error_code === "string" && row.error_code.length > 0
                ? row.error_code
                : "unknown";
            bucket.failedByErrorCode[code] = (bucket.failedByErrorCode[code] ?? 0) + count;
          }
        } else {
          bucket.other += count;
        }
        bucket.total += count;
      }

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      const agentsStatus = await computeAgentsStatus(db, companyId, now);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        agentsStatus,
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
      };
    },
  };
}

// Per-agent status computation for the CMP-379 watch-list field split.
// Surfaces lastRunOutcome, quietSince/quietForMs, quiescenceMode, blockersOpen
// per agent so audits can distinguish "harness errored last run" from
// "agent has been intentionally idle for N hours".
//
// quiescenceMode is currently returned as "unknown" pending the CMP-365
// sibling deliverables:
//   - Child B (adapter retry queue) — needed to detect A_prime (close-out-stuck)
//   - Child C (staleness scanner) — needed to distinguish A vs B1 vs B2 from
//     the agent's blocker chain plus quiet duration
// Once those land, the inference function below should be updated to consume
// their outputs. B2 ("blocked with live chain") is already inferrable from
// blockersOpen > 0 but we keep the field "unknown" until the full taxonomy is
// computable end-to-end to avoid mixed-fidelity reporting.
export async function computeAgentsStatus(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<AgentStatusEntry[]> {
  const agentRows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      lastHeartbeatAt: agents.lastHeartbeatAt,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  if (agentRows.length === 0) return [];

  const agentIds = agentRows.map((row) => row.id);

  // Latest completed heartbeat run per agent. We pull both the status and the
  // finishedAt so quietSince anchors to the last actual run completion when
  // agents.lastHeartbeatAt is unset.
  const latestRunRows = await db
    .select({
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.agentId, agentIds),
        isNotNull(heartbeatRuns.finishedAt),
      ),
    )
    .orderBy(sql`${heartbeatRuns.agentId}, ${heartbeatRuns.finishedAt} desc`);

  const latestByAgent = new Map<
    string,
    { status: string | null; finishedAt: Date | null }
  >();
  for (const row of latestRunRows) {
    if (!latestByAgent.has(row.agentId)) {
      latestByAgent.set(row.agentId, { status: row.status, finishedAt: row.finishedAt });
    }
  }

  // blockersOpen per agent: count distinct blocker issues (issue_relations
  // type='blocks', where the blocked issue is assigned to the agent and the
  // blocker is itself non-terminal).
  //
  // We join issue_relations -> issues (the blocked side, to filter by
  // assignee), then look up blocker statuses in a second pass to avoid
  // joining `issues` twice in the same query.
  const blockedSideRows = await db
    .select({
      blockerIssueId: issueRelations.issueId,
      blockedAgentId: issues.assigneeAgentId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issues.assigneeAgentId, agentIds),
      ),
    );

  const blockerIssueIds = [
    ...new Set(blockedSideRows.map((row) => row.blockerIssueId)),
  ];
  const blockerStatusById = new Map<string, string>();
  if (blockerIssueIds.length > 0) {
    const blockerStatusRows = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(inArray(issues.id, blockerIssueIds));
    for (const row of blockerStatusRows) {
      blockerStatusById.set(row.id, row.status);
    }
  }

  const blockersOpenByAgent = new Map<string, Set<string>>();
  for (const row of blockedSideRows) {
    if (!row.blockedAgentId) continue;
    const blockerStatus = blockerStatusById.get(row.blockerIssueId);
    if (!blockerStatus || TERMINAL_ISSUE_STATUSES.has(blockerStatus)) continue;
    if (!blockersOpenByAgent.has(row.blockedAgentId)) {
      blockersOpenByAgent.set(row.blockedAgentId, new Set());
    }
    blockersOpenByAgent.get(row.blockedAgentId)!.add(row.blockerIssueId);
  }

  return agentRows.map((agent): AgentStatusEntry => {
    const latest = latestByAgent.get(agent.id);
    const quietAnchor = agent.lastHeartbeatAt ?? latest?.finishedAt ?? null;
    return {
      agentId: agent.id,
      name: agent.name,
      // Deprecated single status field — derives from agents.status. Kept for
      // one minor version while consumers migrate to the four orthogonal
      // signals below (CMP-379, sub-finding 1 of CMP-365).
      status: agent.status,
      lastRunOutcome: mapRunStatusToOutcome(latest?.status),
      quietSince: quietAnchor ? quietAnchor.toISOString() : null,
      quietForMs: quietAnchor ? Math.max(0, now.getTime() - quietAnchor.getTime()) : null,
      // See note on quiescenceMode above. Returns "unknown" until CMP-365
      // Children B and C land.
      quiescenceMode: "unknown",
      blockersOpen: blockersOpenByAgent.get(agent.id)?.size ?? 0,
    };
  });
}
