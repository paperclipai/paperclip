import { sql } from "drizzle-orm";
import type { CheckCtx, CheckDef, CheckResult } from "../types.js";

function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = result as { rows?: unknown };
  if (Array.isArray(wrapped?.rows)) return wrapped.rows as T[];
  return [];
}

const COMPANIES = ["HAPPYGANG", "TechOps Marco"] as const;

interface UtilizationRow {
  company: string;
  used: number;
  limit: number;
  utilization_pct: number | null;
}

async function run(ctx: CheckCtx): Promise<CheckResult> {
  const p95 = Number.parseInt(process.env.PAPERCLIP_SHADOW_SYNC_P95 ?? "50", 10);
  const anchor = ctx.now().toISOString();

  try {
    // 1) Insert shadow events for billing_type='subscription_included' from current month
    //    that lack a matching subscription_shadow_v1 entry.
    const inserted = await ctx.db.execute(sql`
      WITH month_start AS (
        SELECT date_trunc('month', ${anchor}::timestamptz AT TIME ZONE 'UTC') AS mstart
      ), src AS (
        SELECT ce.*
          FROM cost_events ce
          CROSS JOIN month_start ms
         WHERE ce.billing_type = 'subscription_included'
           AND ce.occurred_at >= ms.mstart
      ), missing AS (
        SELECT s.*,
               ('shadow-src:' || s.id::text) AS shadow_code,
               GREATEST(1, CEIL((s.input_tokens + s.output_tokens)::numeric / 10000.0))::int AS shadow_cents
          FROM src s
         WHERE NOT EXISTS (
           SELECT 1
             FROM cost_events e
            WHERE e.company_id = s.company_id
              AND e.agent_id = s.agent_id
              AND e.billing_type = 'subscription_shadow_v1'
              AND e.billing_code = ('shadow-src:' || s.id::text)
         )
      )
      INSERT INTO cost_events (
        company_id, agent_id, issue_id, project_id, goal_id,
        billing_code, provider, model,
        input_tokens, output_tokens, cached_input_tokens,
        cost_cents, occurred_at, created_at,
        heartbeat_run_id, biller, billing_type
      )
      SELECT
        m.company_id, m.agent_id, m.issue_id, m.project_id, m.goal_id,
        m.shadow_code, m.provider, m.model,
        0, 0, 0,
        m.shadow_cents, m.occurred_at, ${anchor}::timestamptz,
        m.heartbeat_run_id, 'internal_budget', 'subscription_shadow_v1'
      FROM missing m
      RETURNING id
    `);
    const insertedCount = extractRows<{ id: string }>(inserted).length;

    // 2) Per-company utilization
    const companyList = sql.join(
      COMPANIES.map((c) => sql`${c}`),
      sql`, `,
    );
    const utilRows = await ctx.db.execute(sql`
      WITH month_start AS (
        SELECT date_trunc('month', ${anchor}::timestamptz AT TIME ZONE 'UTC') AS mstart
      ), spend AS (
        SELECT ce.company_id, COALESCE(SUM(ce.cost_cents), 0)::int AS spent_cents
          FROM cost_events ce
          CROSS JOIN month_start ms
         WHERE ce.occurred_at >= ms.mstart
         GROUP BY ce.company_id
      )
      SELECT c.name AS company,
             COALESCE(s.spent_cents, 0)::int AS used,
             c.budget_monthly_cents::int AS "limit",
             CASE WHEN c.budget_monthly_cents > 0
                  THEN ROUND((COALESCE(s.spent_cents, 0)::numeric / c.budget_monthly_cents::numeric) * 100, 1)::float
                  ELSE NULL
             END AS utilization_pct
        FROM companies c
        LEFT JOIN spend s ON s.company_id = c.id
       WHERE c.name IN (${companyList})
       ORDER BY c.name
    `);

    const utilization: UtilizationRow[] = extractRows<{
      company: string;
      used: number;
      limit: number;
      utilization_pct: number | null;
    }>(utilRows).map((r) => ({
      company: r.company,
      used: Number(r.used),
      limit: Number(r.limit),
      utilization_pct: r.utilization_pct === null ? null : Number(r.utilization_pct),
    }));

    const spike = insertedCount > p95 * 3;
    const status: CheckResult["status"] = spike ? "warn" : "ok";

    return {
      status,
      findings: spike ? insertedCount : 0,
      payload: {
        inserted_shadow_events: insertedCount,
        utilization,
        spike,
      },
      summary: spike
        ? `shadow-sync SPIKE: ${insertedCount} inserts (P95×3=${p95 * 3})`
        : `shadow-sync ok: ${insertedCount} inserts`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "error",
      findings: 0,
      payload: { error: msg },
      summary: `shadow-sync ERROR: ${msg}`,
    };
  }
}

export const subscriptionShadowSync: CheckDef = {
  name: "subscription-shadow-sync",
  schedule: "*/30 * * * *",
  notify: "silent",
  run,
};
