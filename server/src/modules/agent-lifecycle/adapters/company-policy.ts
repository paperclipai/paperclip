import { agents, companies, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, asc, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import type { LifecycleEffects } from "./effects.js";
import { applyAgentPolicyHoldsInTransaction } from "./postgres.js";

const inheritedHoldStates = ["preparing", "verifying", "ready", "pausing", "paused", "resuming"] as const;

/** Durable mismatch, also recoverable after a lost notification or a restart. */
export function companyHoldMismatch(companyStatus: SQLWrapper = companies.status) {
  return and(
    inArray(agents.lifecycleState, inheritedHoldStates),
    sql`((coalesce(${agents.lifecycleHolds}, '[]'::jsonb) @> '["company_paused"]'::jsonb) <> (${companyStatus} = 'paused')
      or (coalesce(${agents.lifecycleHolds}, '[]'::jsonb) @> '["company_archived"]'::jsonb) <> (${companyStatus} = 'archived')
      or (${companyStatus} in ('paused', 'archived') and ${agents.lifecycleState} in ('preparing', 'verifying', 'ready', 'resuming')))`,
  );
}

export async function hasCompanyHoldMismatch(db: Db) {
  const rows = await db.select({ id: agents.id }).from(agents).innerJoin(companies, eq(companies.id, agents.companyId))
    .where(companyHoldMismatch()).limit(1);
  return rows.length > 0;
}

/** One accounting transaction per changed company page, never one per member. */
export async function projectCompanyHolds(db: Db, effects: LifecycleEffects, companyId?: string) {
  const [candidate] = await db.select({ companyId: agents.companyId }).from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(companyHoldMismatch(), companyId ? eq(agents.companyId, companyId) : undefined))
    .orderBy(asc(agents.companyId)).limit(1);
  if (!candidate) return 0;
  return effects.transaction(db, candidate.companyId, async tx => {
    const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, candidate.companyId));
    if (!company) return 0;
    // Company is locked by the accounting boundary; select only stale projections.
    const rows = await tx.select().from(agents).where(and(
      eq(agents.companyId, candidate.companyId),
      companyHoldMismatch(sql`${company.status}::text`),
    )).orderBy(asc(agents.id)).limit(100).for("update", { skipLocked: true });
    const stopping = company.status === "paused" || company.status === "archived";
    const running = stopping && rows.length ? await tx.selectDistinct({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, candidate.companyId), inArray(heartbeatRuns.agentId, rows.map(row => row.id)),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    )) : [];
    const activeAgents = new Set(running.map(row => row.agentId));
    for (const row of rows) {
      await applyAgentPolicyHoldsInTransaction(tx, effects, candidate.companyId, row.id,
        { companyStatus: company.status, restartPause: activeAgents.has(row.id) }, row);
    }
    return rows.length;
  });
}

/** Persist stop ownership for involved agents before a company pause commits.
 * Later reactivation may remove the inherited hold, but cannot erase pausing. */
export async function fenceActiveCompanyAgentStopsInTransaction(tx: Db, effects: LifecycleEffects,
  companyId: string, status: "paused" | "archived") {
  const active = await tx.selectDistinct({ id: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
  )).orderBy(asc(heartbeatRuns.agentId));
  let fenced = 0;
  for (let offset = 0; offset < active.length; offset += 100) {
    const rows = await tx.select().from(agents).where(and(eq(agents.companyId, companyId),
      inArray(agents.id, active.slice(offset, offset + 100).map(agent => agent.id)),
      inArray(agents.lifecycleState, inheritedHoldStates),
    )).orderBy(asc(agents.id)).for("update");
    for (const row of rows) {
      await applyAgentPolicyHoldsInTransaction(tx, effects, companyId, row.id,
        { companyStatus: status, restartPause: true }, row);
      fenced += 1;
    }
  }
  return fenced;
}
