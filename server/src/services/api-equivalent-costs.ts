import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { priceAtListPrice, type ApiEquivalent } from "@paperclipai/shared";
import type { CostDateRange } from "./cost-date-range.js";

type Row = {
  agent_id: string | null;
  model: string;
  source: "reported" | "table" | "ledger";
  cost_cents: string | number;
  reported_cents: string | number;
  input_tokens: string | number;
  cached_input_tokens: string | number;
  cache_write_tokens: string | number;
  output_tokens: string | number;
};

export function emptyApiEquivalent(): ApiEquivalent {
  return { cents: 0, reportedCents: 0, listPriceCents: 0, unpricedTokens: 0, unpricedModels: [] };
}

function add(target: ApiEquivalent, row: Row) {
  const num = (value: string | number) => Number(value) || 0;
  if (row.source === "ledger") {
    target.cents += num(row.cost_cents);
    return;
  }
  if (row.source === "reported") {
    target.cents += num(row.reported_cents);
    target.reportedCents += num(row.reported_cents);
    return;
  }
  const input = num(row.input_tokens);
  const tokens = {
    inputTokens: input,
    cachedInputTokens: num(row.cached_input_tokens),
    // Older receipts may not count cache writes inside input; never exceed it.
    cacheWriteTokens: Math.min(num(row.cache_write_tokens), input),
    outputTokens: num(row.output_tokens),
  };
  const cents = priceAtListPrice(row.model, tokens);
  if (cents === null) {
    target.unpricedTokens += tokens.inputTokens + tokens.cachedInputTokens + tokens.outputTokens;
    if (!target.unpricedModels.includes(row.model)) target.unpricedModels.push(row.model);
    return;
  }
  target.cents += cents;
  target.listPriceCents += cents;
}

/**
 * API-equivalent cost per agent (null key = usage without an agent), computed
 * at read time. A subscription run's own reported API price (Claude Code's
 * `costUsd`) wins when the run produced exactly one ledger event; split runs
 * and runs without a reported price use the list-price table. Other billing
 * keeps its ledger cost, and unpriced ledger events use the table too.
 */
export async function apiEquivalentByAgent(db: Db, companyId: string, range?: CostDateRange): Promise<Map<string | null, ApiEquivalent>> {
  const from = range?.from ? sql`and e.occurred_at >= ${range.from.toISOString()}::timestamptz` : sql``;
  const to = range?.to ? sql`and e.occurred_at <= ${range.to.toISOString()}::timestamptz` : sql``;
  const rows = await db.execute<Row>(sql`
    with ev as (
      select e.agent_id, e.model, e.billing_type, e.cost_status, e.cost_cents, e.heartbeat_run_id,
        case when e.receipt_hash is null and e.provider = 'openai' and e.model not like 'openai/_%'
          then greatest(0, e.input_tokens - e.cached_input_tokens) else e.input_tokens end as input_tokens,
        e.cached_input_tokens, e.output_tokens
      from cost_events e
      where e.company_id = ${companyId} ${from} ${to}
    ),
    run_events as (
      select heartbeat_run_id, count(*) as n from cost_events
      where company_id = ${companyId} and heartbeat_run_id in (select heartbeat_run_id from ev where heartbeat_run_id is not null)
      group by heartbeat_run_id
    ),
    priced as (
      select ev.*,
        case when re.n = 1 then coalesce(r.usage_json->>'costUsdExact', r.usage_json->>'costUsd') end as reported_usd,
        case when re.n = 1 and (r.usage_json->>'cacheWriteTokens') ~ '^[0-9]+$'
          then (r.usage_json->>'cacheWriteTokens')::numeric else 0 end as cache_write_tokens
      from ev
      left join run_events re on re.heartbeat_run_id = ev.heartbeat_run_id
      left join heartbeat_runs r on r.id = ev.heartbeat_run_id and r.company_id = ${companyId}
    ),
    sourced as (
      select *,
        case
          when billing_type in ('subscription_included', 'subscription_overage')
            and reported_usd ~ '^[0-9]+(\\.[0-9]+)?$' then 'reported'
          when billing_type in ('subscription_included', 'subscription_overage') or cost_status = 'unpriced' then 'table'
          else 'ledger'
        end as source
      from priced
    )
    select agent_id, model, source,
      coalesce(sum(cost_cents), 0)::text as cost_cents,
      coalesce(sum(case when source = 'reported' then reported_usd::numeric * 100 else 0 end), 0)::text as reported_cents,
      coalesce(sum(input_tokens), 0)::text as input_tokens,
      coalesce(sum(cached_input_tokens), 0)::text as cached_input_tokens,
      coalesce(sum(cache_write_tokens), 0)::text as cache_write_tokens,
      coalesce(sum(output_tokens), 0)::text as output_tokens
    from sourced
    group by agent_id, model, source`);
  const result = new Map<string | null, ApiEquivalent>();
  for (const row of rows as unknown as Row[]) {
    const entry = result.get(row.agent_id) ?? emptyApiEquivalent();
    add(entry, row);
    result.set(row.agent_id, entry);
  }
  return result;
}

export function sumApiEquivalents(values: Iterable<ApiEquivalent>): ApiEquivalent {
  const total = emptyApiEquivalent();
  for (const value of values) {
    total.cents += value.cents;
    total.reportedCents += value.reportedCents;
    total.listPriceCents += value.listPriceCents;
    total.unpricedTokens += value.unpricedTokens;
    for (const model of value.unpricedModels) if (!total.unpricedModels.includes(model)) total.unpricedModels.push(model);
  }
  return total;
}
