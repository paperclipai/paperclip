import { sql } from "drizzle-orm";
import type { CheckCtx, CheckDef, CheckResult } from "../types.js";

const PREFIX = "/Users/marco/.openclaw/workspace";
const LOCAL_ADAPTERS = ["claude_local", "codex_local", "hermes_local"] as const;
const COMPANIES = ["HAPPYGANG", "Casa Marco"] as const;

interface CompanyDrift {
  name: string;
  local_agent_cwd_outside: number;
  active_exec_ws_outside: number;
  open_issues_without_project_workspace: number;
  run_event_context_cwd_outside_24h: number;
}

async function run(ctx: CheckCtx): Promise<CheckResult> {
  const prefixLike = `${PREFIX}%`;

  const companyNamesList = sql.join(
    COMPANIES.map((v) => sql`${v}`),
    sql`, `,
  );
  const localAdaptersList = sql.join(
    LOCAL_ADAPTERS.map((v) => sql`${v}`),
    sql`, `,
  );
  const companyRows = await ctx.db.execute(sql`
    SELECT id, name FROM companies WHERE name IN (${companyNamesList})
  `);

  const drifts: CompanyDrift[] = [];
  const examples: string[] = [];

  const companies = companyRows as unknown as Array<{ id: string; name: string }>;
  for (const c of companies) {
    const a = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
        FROM agents
       WHERE company_id = ${c.id}
         AND adapter_type IN (${localAdaptersList})
         AND COALESCE(adapter_config->>'cwd', '') <> ''
         AND COALESCE(adapter_config->>'cwd', '') NOT LIKE ${prefixLike}
    `);
    const ews = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
        FROM execution_workspaces
       WHERE company_id = ${c.id}
         AND status = 'active'
         AND COALESCE(provider_ref, cwd, '') <> ''
         AND COALESCE(provider_ref, cwd, '') NOT LIKE ${prefixLike}
    `);
    const iss = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
        FROM issues i
        LEFT JOIN project_workspaces pw ON pw.project_id = i.project_id
       WHERE i.company_id = ${c.id}
         AND i.status NOT IN ('done','cancelled')
         AND i.project_id IS NOT NULL
         AND pw.id IS NULL
    `);
    const re = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
        FROM heartbeat_run_events
       WHERE company_id = ${c.id}
         AND created_at > NOW() - INTERVAL '24 hours'
         AND COALESCE(payload->'context'->'paperclipWorkspace'->>'cwd', '') <> ''
         AND COALESCE(payload->'context'->'paperclipWorkspace'->>'cwd', '') NOT LIKE ${prefixLike}
    `);
    const ex = await ctx.db.execute(sql`
      SELECT DISTINCT COALESCE(provider_ref, cwd) AS path
        FROM execution_workspaces
       WHERE company_id = ${c.id}
         AND status = 'active'
         AND COALESCE(provider_ref, cwd, '') <> ''
         AND COALESCE(provider_ref, cwd, '') NOT LIKE ${prefixLike}
       LIMIT 3
    `);

    const aRows = a as unknown as Array<{ n: number }>;
    const ewsRows = ews as unknown as Array<{ n: number }>;
    const issRows = iss as unknown as Array<{ n: number }>;
    const reRows = re as unknown as Array<{ n: number }>;
    const exRows = ex as unknown as Array<{ path: string }>;
    const drift: CompanyDrift = {
      name: c.name,
      local_agent_cwd_outside: Number(aRows[0]?.n ?? 0),
      active_exec_ws_outside: Number(ewsRows[0]?.n ?? 0),
      open_issues_without_project_workspace: Number(issRows[0]?.n ?? 0),
      run_event_context_cwd_outside_24h: Number(reRows[0]?.n ?? 0),
    };
    drifts.push(drift);
    for (const r of exRows) examples.push(`${c.name}:${r.path}`);
  }

  const findings = drifts.reduce(
    (acc, c) =>
      acc +
      c.local_agent_cwd_outside +
      c.active_exec_ws_outside +
      c.open_issues_without_project_workspace +
      c.run_event_context_cwd_outside_24h,
    0,
  );

  const status: CheckResult["status"] = findings > 0 ? "warn" : "ok";
  const summary =
    drifts
      .map(
        (d) =>
          `${d.name}: ${d.local_agent_cwd_outside}/${d.active_exec_ws_outside}/${d.open_issues_without_project_workspace}/${d.run_event_context_cwd_outside_24h}`,
      )
      .join(", ") || "no companies matched";

  return {
    status,
    findings,
    payload: { companies: drifts, examples },
    summary: findings > 0 ? `Drift: ${summary}` : `clean: ${summary}`,
  };
}

export const workspaceDriftGuard: CheckDef = {
  name: "workspace-drift-guard",
  schedule: "0 9,18,22 * * *",
  notify: "threshold",
  thresholdSeverity: "warn",
  run,
};
