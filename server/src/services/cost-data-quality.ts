import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { CostDataQualityItem, CostDataQualityReport } from "@paperclipai/shared";
import { resolveCostDateRange, type CostDateRange } from "./cost-date-range.js";
import { withAccountingReadSnapshot } from "./accounting-transaction.js";

const PAGE_SIZE = 25;
// A display distinction, never authority to acknowledge missing usage as zero.
export const RECEIPT_WAIT_MS = 15 * 60 * 1000;

/** Safe explanations for cost readers: bounded metadata only, never raw errors,
 * credential identities, prompts, environments, or untrusted provider payloads. */
export async function costDataQualityReport(db: Db, companyId: string, canRetry: boolean, range?: CostDateRange, now = new Date()): Promise<CostDataQualityReport> {
  return withAccountingReadSnapshot(db, companyId, async tx => {
    const period = resolveCostDateRange(range, now);
    const eventFrom = period.from ? sql`and e.occurred_at >= ${period.from.toISOString()}::timestamptz` : sql``;
    const eventTo = period.to ? sql`and e.occurred_at <= ${period.to.toISOString()}::timestamptz` : sql``;
    const runFrom = period.from ? sql`and coalesce(r.finished_at,r.created_at) >= ${period.from.toISOString()}::timestamptz` : sql``;
    const runTo = period.to ? sql`and coalesce(r.finished_at,r.created_at) <= ${period.to.toISOString()}::timestamptz` : sql``;
    const [events, runs] = await Promise.all([
      tx.execute<CostDataQualityItem & Record<string, unknown>>(sql`
        select e.id, e.heartbeat_run_id as "runId", e.agent_id as "agentId", a.name as "agentName", a.appearance as "agentAppearance",
          e.occurred_at::text as "occurredAt", e.provider, e.model,
          case when e.billing_type = 'unknown' then 'unknown_billing'
            when e.model in ('unknown','') then 'missing_model' else 'missing_price' end as reason
        from cost_events e left join agents a on a.id = e.agent_id and a.company_id = e.company_id
        where e.company_id = ${companyId} ${eventFrom} ${eventTo}
          and (e.billing_type = 'unknown' or (e.cost_status = 'unpriced' and e.billing_type <> 'subscription_included'))
        order by e.occurred_at desc,e.id limit ${PAGE_SIZE + 1}`),
      tx.execute<CostDataQualityItem & Record<string, unknown>>(sql`
        select r.id, r.id as "runId", r.agent_id as "agentId", a.name as "agentName", a.appearance as "agentAppearance",
          coalesce(r.finished_at,r.created_at)::text as "occurredAt",
          r.usage_json->>'provider' as provider,r.usage_json->>'model' as model,
          case when r.cost_accounted_at is not null then 'retryable'
          when r.usage_json->'accountingCaptureFailed' is distinct from 'true'::jsonb
            and (r.usage_json->'accountingProviderWorkStarted' = 'false'::jsonb
              or r.result_json->'executionRecovery'->'providerWorkStarted' = 'false'::jsonb) then 'retryable'
          when r.usage_json->'accountingCaptureFailed' = 'true'::jsonb
            or r.usage_json->'accountingReceiptReady' = 'false'::jsonb
            or (r.runtime_mode = 'native' and exists (select 1 from native_run_finalizations f
              where f.run_id = r.id and f.company_id = r.company_id and f.result_id is null and f.phase <> 'terminal_failure'))
            then case when coalesce(r.finished_at,r.created_at) <= ${new Date(now.getTime() - RECEIPT_WAIT_MS).toISOString()}::timestamptz
              then 'receipt_unavailable' else 'waiting_for_receipt' end
          else 'retryable' end as reason
        from heartbeat_runs r left join agents a on a.id = r.agent_id and a.company_id = r.company_id
        where r.company_id = ${companyId} and r.cost_accounting_pending
          and r.status in ('succeeded','failed','timed_out','cancelled','interrupted') ${runFrom} ${runTo}
        order by coalesce(r.finished_at,r.created_at) desc,r.id limit ${PAGE_SIZE + 1}`),
    ]);
    // PostgreSQL's text timestamp is not portable to every browser's Date parser.
    const items = (rows: readonly CostDataQualityItem[]) => rows.slice(0, PAGE_SIZE).map(row => ({
      ...row, occurredAt: new Date(row.occurredAt).toISOString(),
    }));
    return { canRetry, events: items(Array.from(events)), runs: items(Array.from(runs)),
      hasMoreEvents: events.length > PAGE_SIZE, hasMoreRuns: runs.length > PAGE_SIZE };
  });
}
