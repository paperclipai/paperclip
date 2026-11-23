import { and, eq, sql } from "drizzle-orm";
import { accountingRuntimeBaselines, heartbeatRuns, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

/** A missing baseline is initialized once, before this owner's first ledger-only
 * acknowledgement. The compatibility floor must have drained legacy writers. */
export async function ensureRuntimeAccountingBaseline(tx: Db, companyId: string, agentId: string) {
  const [baseline] = await tx.select({ agentId: accountingRuntimeBaselines.agentId }).from(accountingRuntimeBaselines)
    .where(and(eq(accountingRuntimeBaselines.companyId, companyId), eq(accountingRuntimeBaselines.agentId, agentId)));
  if (baseline) return;
  const [acknowledged] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.costAccountedAt} is not null`,
    sql`${heartbeatRuns.accountingProjectionVersion} in ('v2')`,
  )).limit(1);
  if (acknowledged) throw conflict("Runtime accounting baseline is missing; reconcile historical accounting before retrying");
  // This row is independent from the mutable runtime/session row. Do not create
  // or update agent_runtime_state from the settlement path.
  await tx.execute(sql`insert into accounting_runtime_baselines
    (agent_id, company_id, cost_cents, input_tokens, cached_input_tokens, output_tokens)
    select ${agentId}::uuid, ${companyId}::uuid,
      coalesce(a.total_cost_cents, 0), coalesce(a.total_input_tokens, 0),
      coalesce(a.total_cached_input_tokens, 0), coalesce(a.total_output_tokens, 0)
    from (select 1) seed left join agent_runtime_state a
      on a.agent_id = ${agentId}::uuid and a.company_id = ${companyId}::uuid
    on conflict (agent_id) do nothing`);
}

/** Public totals are a single committed ledger snapshot. Legacy rows without a
 * baseline retain their frozen historical values until the first new receipt. */
export async function readRuntimeAccountingTotals(db: Db, companyId: string, agentId: string) {
  const [totals] = await db.execute<{
    totalCostCents: string; totalInputTokens: string; totalCachedInputTokens: string; totalOutputTokens: string;
  }>(sql`with ledger as (
    select coalesce(sum(e.cost_cents), 0) as cents, coalesce(sum(e.input_tokens), 0) as input,
      coalesce(sum(e.cached_input_tokens), 0) as cached, coalesce(sum(e.output_tokens), 0) as output
    from cost_events e join heartbeat_runs r on r.id = e.heartbeat_run_id and r.company_id = e.company_id
    where r.company_id = ${companyId}::uuid and r.agent_id = ${agentId}::uuid
      and r.cost_accounted_at is not null and r.accounting_projection_version in ('v2')
  ) select
    (case when b.agent_id is null then coalesce(a.total_cost_cents, 0) else b.cost_cents + l.cents end)::text as "totalCostCents",
    (case when b.agent_id is null then coalesce(a.total_input_tokens, 0) else b.input_tokens + l.input end)::text as "totalInputTokens",
    (case when b.agent_id is null then coalesce(a.total_cached_input_tokens, 0) else b.cached_input_tokens + l.cached end)::text as "totalCachedInputTokens",
    (case when b.agent_id is null then coalesce(a.total_output_tokens, 0) else b.output_tokens + l.output end)::text as "totalOutputTokens"
    from ledger l left join accounting_runtime_baselines b on b.agent_id = ${agentId}::uuid and b.company_id = ${companyId}::uuid
    left join agent_runtime_state a on a.agent_id = ${agentId}::uuid and a.company_id = ${companyId}::uuid`);
  return {
    totalCostCents: Number(totals.totalCostCents), totalInputTokens: Number(totals.totalInputTokens),
    totalCachedInputTokens: Number(totals.totalCachedInputTokens), totalOutputTokens: Number(totals.totalOutputTokens),
  };
}
