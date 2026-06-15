import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, companies } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";

const PORTFOLIO_CAPABILITY = "portfolio_metrics:read";
const FAILURE_STATUSES = ["failed", "timed_out", "errored"] as const;

export interface PortfolioRunsQuery {
  actor: Express.Request["actor"];
  since: Date;
  until: Date;
  companyIds: string[];
}

export interface PortfolioRunsRow {
  company_id: string;
  agent_id: string;
  runs_total: number;
  runs_succeeded: number;
  runs_failed: number;
  seconds_on_task: number;
  distinct_issues: number;
  heartbeats_avg: number;
}

function parseCapabilities(raw: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function portfolioService(db: Db) {
  async function assertAgentAccess(actor: Express.Request["actor"], companyIds: string[]) {
    if (actor.type !== "agent" || !actor.agentId || !actor.companyId) {
      throw forbidden("Portfolio access denied");
    }

    const agent = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        capabilities: agents.capabilities,
      })
      .from(agents)
      .where(eq(agents.id, actor.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent || agent.companyId !== actor.companyId) {
      throw forbidden("Portfolio access denied");
    }
    if (!parseCapabilities(agent.capabilities).has(PORTFOLIO_CAPABILITY)) {
      throw forbidden("Agent lacks portfolio_metrics:read");
    }

    const allowedCompanies = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          inArray(companies.id, companyIds),
          eq(companies.parentCompanyId, actor.companyId),
        ),
      );

    if (allowedCompanies.length !== companyIds.length) {
      throw forbidden("Portfolio company scope denied");
    }
  }

  return {
    async listRunsRollup(input: PortfolioRunsQuery) {
      if (input.actor.type === "agent") {
        await assertAgentAccess(input.actor, input.companyIds);
      }

      if (input.companyIds.length === 0) {
        return [];
      }

      const companyIdsParam = sql`${sql.join(
        input.companyIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}`;
      const failureStatusesParam = sql`${sql.join(
        FAILURE_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )}`;

      const result = await db.execute(sql`
        WITH aggregated AS (
          SELECT
            hr.company_id,
            hr.agent_id,
            COUNT(*)::int AS runs_total,
            COUNT(*) FILTER (WHERE hr.status = 'succeeded')::int AS runs_succeeded,
            COUNT(*) FILTER (WHERE hr.status IN (${failureStatusesParam}))::int AS runs_failed,
            COALESCE(
              SUM(
                CASE
                  WHEN hr.started_at IS NOT NULL AND hr.finished_at IS NOT NULL
                    THEN GREATEST(EXTRACT(EPOCH FROM (hr.finished_at - hr.started_at)), 0)
                  ELSE 0
                END
              ),
              0
            )::int AS seconds_on_task,
            COUNT(DISTINCT hr.context_snapshot ->> 'issueId')::int AS distinct_issues
          FROM heartbeat_runs hr
          WHERE
            hr.company_id IN (${companyIdsParam})
            AND hr.started_at >= ${input.since.toISOString()}::timestamptz
            AND hr.started_at < ${input.until.toISOString()}::timestamptz
          GROUP BY hr.company_id, hr.agent_id
        )
        SELECT
          company_id,
          agent_id,
          runs_total,
          runs_succeeded,
          runs_failed,
          seconds_on_task,
          distinct_issues,
          CASE
            WHEN distinct_issues > 0
              THEN ROUND((runs_total::numeric / distinct_issues::numeric), 2)::double precision
            ELSE 0::double precision
          END AS heartbeats_avg
        FROM aggregated
        ORDER BY company_id ASC, agent_id ASC
      `);

      const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
      return (rows as Array<Record<string, unknown>>).map((row) => ({
        company_id: String(row.company_id),
        agent_id: String(row.agent_id),
        runs_total: Number(row.runs_total ?? 0),
        runs_succeeded: Number(row.runs_succeeded ?? 0),
        runs_failed: Number(row.runs_failed ?? 0),
        seconds_on_task: Number(row.seconds_on_task ?? 0),
        distinct_issues: Number(row.distinct_issues ?? 0),
        heartbeats_avg: Number(row.heartbeats_avg ?? 0),
      })) satisfies PortfolioRunsRow[];
    },
  };
}
