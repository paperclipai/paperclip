import { and, eq, sql } from "drizzle-orm";
import { agents, agentRuntimeState, companies, heartbeatRuns, type Db } from "@paperclipai/db";
import { normalizeCents, usdToCents, type AccountingFinding, type AccountingHealth, type AccountingInspection } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { receiptFingerprint } from "./receipt-fingerprint.js";
import { withAccountingReadSnapshot, withAccountingTransaction } from "./accounting-transaction.js";
import { logActivity } from "./activity-log.js";
import { accountRunCost } from "./run-cost-accounting.js";
import type { BudgetServiceHooks } from "./budgets.js";

/** Independent aggregation: deliberately does not reuse writer projections. */
async function inspect(tx: Db, companyId: string): Promise<AccountingInspection> {
  const findings: AccountingFinding[] = [];
  const monthly = await tx.execute<{ kind: "company_projection" | "agent_projection"; id: string; actual: string; expected: string }>(sql`
    with month_events as (select agent_id, cost_cents from cost_events where company_id = ${companyId}
      and occurred_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
      and occurred_at < (date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC')
    select 'company_projection' as kind, id, spent_monthly_cents::text as actual,
      (select coalesce(sum(cost_cents),0)::text from month_events) as expected from companies where id = ${companyId}
    union all select 'agent_projection', a.id, a.spent_monthly_cents::text,
      coalesce((select sum(e.cost_cents) from month_events e where e.agent_id = a.id),0)::text from agents a where a.company_id = ${companyId}`);
  for (const row of monthly) if (normalizeCents(row.actual) !== normalizeCents(row.expected)) findings.push({ kind: row.kind, entityId: row.id, repairable: true,
    actual: { cents: normalizeCents(row.actual) }, expected: { cents: normalizeCents(row.expected) } });
  const runtime = await tx.execute<{ id: string; baseline: string | null; actual: Record<string, string>; expected: Record<string, string> }>(sql`
    with totals as (select r.agent_id, sum(e.cost_cents) as cents, sum(e.input_tokens) as input, sum(e.cached_input_tokens) as cached, sum(e.output_tokens) as output
      from heartbeat_runs r join cost_events e on e.heartbeat_run_id = r.id and e.company_id = r.company_id
      where r.company_id = ${companyId} and r.accounting_projection_version = 'v2' and r.cost_accounted_at is not null group by r.agent_id)
    select a.agent_id as id, b.agent_id as baseline,
      jsonb_build_object('cents', a.total_cost_cents::text, 'input', a.total_input_tokens::text, 'cached', a.total_cached_input_tokens::text, 'output', a.total_output_tokens::text) as actual,
      jsonb_build_object('cents', (coalesce(b.cost_cents,0) + coalesce(t.cents,0))::text, 'input', (coalesce(b.input_tokens,0) + coalesce(t.input,0))::text,
        'cached', (coalesce(b.cached_input_tokens,0) + coalesce(t.cached,0))::text, 'output', (coalesce(b.output_tokens,0) + coalesce(t.output,0))::text) as expected
      from agent_runtime_state a left join accounting_runtime_baselines b on b.agent_id = a.agent_id and b.company_id = a.company_id
      left join totals t on t.agent_id = a.agent_id where a.company_id = ${companyId} order by a.agent_id`);
  for (const row of runtime) {
    if (!row.baseline) { findings.push({ kind: "legacy_runtime", entityId: row.id, repairable: false, actual: row.actual, expected: {} }); continue; }
    row.actual.cents = normalizeCents(row.actual.cents); row.expected.cents = normalizeCents(row.expected.cents);
    if (Object.keys(row.expected).some(key => row.actual[key] !== row.expected[key])) findings.push({ kind: "runtime_projection", entityId: row.id, repairable: true, actual: row.actual, expected: row.expected });
  }
  const incomplete = await tx.execute<{ id: string; acknowledged: boolean; events: number }>(sql`
    select r.id, r.cost_accounted_at is not null as acknowledged, count(e.id)::int as events from heartbeat_runs r
      left join cost_events e on e.heartbeat_run_id = r.id and e.company_id = r.company_id and e.idempotency_key like ('heartbeat:' || r.id::text || ':%')
      where r.company_id = ${companyId} and r.status in ('succeeded','failed','timed_out','cancelled','interrupted')
      and (r.cost_accounting_pending or r.accounting_projection_version = 'v2')
      and r.result_json->'executionRecovery'->>'providerWorkStarted' is distinct from 'false'
      and r.usage_json->>'accountingProviderWorkStarted' is distinct from 'false'
      group by r.id having r.cost_accounted_at is null or count(e.id) = 0 order by r.id`);
  for (const row of incomplete) findings.push({ kind: row.acknowledged ? "missing_receipt" : "missing_acknowledgement", entityId: row.id, repairable: false,
    actual: { acknowledged: String(row.acknowledged), events: String(row.events) }, expected: { acknowledged: "true", events: ">=1" } });
  // Verify new run receipts independently of the projections. Corrections
  // change effective valuation, while reported_cost_cents preserves the
  // provider amount this acknowledgement originally consumed.
  const receipts = await tx.execute<{ id: string; usage: Record<string, unknown>; actual: Record<string, string> }>(sql`
    select r.id, r.usage_json as usage, jsonb_build_object('cents', sum(coalesce(e.reported_cost_cents,e.cost_cents))::text,
      'input', sum(e.input_tokens)::text, 'cached', sum(e.cached_input_tokens)::text, 'output', sum(e.output_tokens)::text) as actual
    from heartbeat_runs r join cost_events e on e.heartbeat_run_id = r.id and e.company_id = r.company_id and e.idempotency_key like ('heartbeat:' || r.id::text || ':%')
    where r.company_id = ${companyId} and r.accounting_projection_version = 'v2' and r.cost_accounted_at is not null group by r.id order by r.id`);
  for (const row of receipts) {
    const usage = row.usage ?? {};
    const cost = usage.cacheAdjustedCostUsd ?? usage.costUsdExact ?? usage.costUsd ?? 0;
    let cents: string;
    try { cents = usage.billingType === "subscription_included" ? "0.0000000" : usdToCents(String(cost)); }
    catch { cents = "invalid receipt"; }
    const expected = { cents, input: String(usage.inputTokens ?? 0), cached: String(usage.cachedInputTokens ?? 0), output: String(usage.outputTokens ?? 0) };
    row.actual.cents = normalizeCents(row.actual.cents);
    if (Object.entries(expected).some(([key,value]) => row.actual[key] !== value)) findings.push({ kind: "receipt_mismatch", entityId: row.id, repairable: false, actual: row.actual, expected });
  }
  findings.sort((a,b) => a.kind.localeCompare(b.kind) || a.entityId.localeCompare(b.entityId));
  return { companyId, findings, fingerprint: receiptFingerprint({ companyId, findings }), checkedAt: new Date().toISOString() };
}

export function accountingIntegrityService(db: Db, hooks: BudgetServiceHooks = {}) {
  return {
    inspect: (companyId: string) => withAccountingReadSnapshot(db, companyId, tx => inspect(tx, companyId)),
    repair: (companyId: string, fingerprint: string, reason: string, actorId: string) => withAccountingTransaction(db, companyId, async (tx, publications) => {
      if (!reason.trim()) throw conflict("A repair reason is required");
      const before = await inspect(tx, companyId);
      if (before.fingerprint !== fingerprint) throw conflict("Accounting changed since inspection; inspect again before repairing");
      for (const finding of before.findings.filter(f => f.repairable)) {
        if (finding.kind === "company_projection") await tx.update(companies).set({ spentMonthlyCents: sql`${finding.expected.cents}::numeric`, updatedAt: new Date() }).where(eq(companies.id, companyId));
        if (finding.kind === "agent_projection") await tx.update(agents).set({ spentMonthlyCents: sql`${finding.expected.cents}::numeric`, updatedAt: new Date() }).where(and(eq(agents.id, finding.entityId), eq(agents.companyId, companyId)));
        if (finding.kind === "runtime_projection") await tx.update(agentRuntimeState).set({ totalCostCents: sql`${finding.expected.cents}::numeric`,
          totalInputTokens: sql`${finding.expected.input}::bigint`, totalCachedInputTokens: sql`${finding.expected.cached}::bigint`, totalOutputTokens: sql`${finding.expected.output}::bigint`, updatedAt: new Date(),
        }).where(and(eq(agentRuntimeState.agentId, finding.entityId), eq(agentRuntimeState.companyId, companyId)));
      }
      await logActivity(tx, { companyId, actorType: "user", actorId, action: "accounting.projections_repaired", entityType: "company", entityId: companyId,
        details: { fingerprint, reason, repairs: before.findings.filter(f => f.repairable) } }, publications);
      return inspect(tx, companyId);
    }),
    retry: async (companyId: string, runId: string, actorId: string) => {
      const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
      if (!run) throw notFound("Accounting run not found");
      await logActivity(db, { companyId, actorType: "user", actorId, action: "accounting.retry_requested", entityType: "heartbeat_run", entityId: runId });
      try { return { accounted: await accountRunCost(db, runId, hooks) }; }
      catch (error) {
        await db.update(heartbeatRuns).set({ accountingLastAttemptAt: new Date(), accountingAttemptCount: sql`${heartbeatRuns.accountingAttemptCount} + 1`,
          accountingLastError: error instanceof Error ? error.message.slice(0,1000) : "Accounting retry failed",
        }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
        throw error;
      }
    },
    health: (companyId: string): Promise<AccountingHealth> => withAccountingReadSnapshot(db, companyId, async tx => {
      const [counts] = await tx.execute<{ pending: number; unpriced: number; oldest: string | null; cancellations: number; reserved: string }>(sql`
        select (select count(*)::int from heartbeat_runs where company_id = ${companyId} and cost_accounting_pending and status in ('succeeded','failed','timed_out','cancelled','interrupted')) as pending,
        (select count(*)::int from cost_events where company_id = ${companyId} and cost_status = 'unpriced' and billing_type <> 'subscription_included') as unpriced,
        (select min(coalesce(finished_at,created_at))::text from heartbeat_runs where company_id = ${companyId} and cost_accounting_pending and status in ('succeeded','failed','timed_out','cancelled','interrupted')) as oldest,
        (select count(*)::int from budget_policies where company_id = ${companyId} and enforcement_version > enforcement_delivered_version) as cancellations,
        (select coalesce(sum(amount_cents),0)::text from budget_reservations where company_id = ${companyId} and state = 'held') as reserved`);
      const pending = await tx.execute<{ runId: string; agentId: string; state: "waiting_for_receipt" | "retryable"; lastError: string | null; attempts: number; since: string; lastAttemptAt: string | null }>(sql`
        select id as "runId", agent_id as "agentId", case when usage_json->>'accountingReceiptReady' = 'false'
          and usage_json->>'accountingProviderWorkStarted' is distinct from 'false'
          and result_json->'executionRecovery'->>'providerWorkStarted' is distinct from 'false' then 'waiting_for_receipt' else 'retryable' end as state,
        accounting_last_error as "lastError", accounting_attempt_count as attempts, coalesce(finished_at,created_at)::text as since, accounting_last_attempt_at::text as "lastAttemptAt"
        from heartbeat_runs where company_id = ${companyId} and cost_accounting_pending and status in ('succeeded','failed','timed_out','cancelled','interrupted') order by coalesce(finished_at,created_at),id limit 100`);
      const unpriced = await tx.execute<{ runId: string | null; costEventId: string; agentId: string | null; since: string }>(sql`
        select heartbeat_run_id as "runId", id as "costEventId", agent_id as "agentId", occurred_at::text as since from cost_events
        where company_id = ${companyId} and cost_status = 'unpriced' and billing_type <> 'subscription_included' order by occurred_at,id limit 100`);
      return { companyId, pendingRunCount: counts.pending, unpricedEventCount: counts.unpriced, oldestPendingAt: counts.oldest, pendingCancellationCount: counts.cancellations,
        heldReservationCents: normalizeCents(counts.reserved), items: [...pending, ...unpriced.map(row => ({ ...row, state: "unpriced" as const, lastError: null, attempts: 0, lastAttemptAt: null }))] };
    }),
  };
}
