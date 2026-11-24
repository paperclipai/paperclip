import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { ApiEquivalent } from "@paperclipai/shared";
import type { CostDateRange } from "./cost-date-range.js";
import { priceAtListPrice } from "./model-list-prices.js";

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

const DECIMAL_PATTERN = "^[+]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?$";

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
    cacheWriteTokens: Math.min(num(row.cache_write_tokens), input),
    outputTokens: num(row.output_tokens),
  };
  const total = tokens.inputTokens + tokens.cachedInputTokens + tokens.outputTokens;
  if (total === 0) return;
  const cents = priceAtListPrice(row.model, tokens);
  if (cents === null) {
    target.unpricedTokens += total;
    if (!target.unpricedModels.includes(row.model)) target.unpricedModels.push(row.model);
    return;
  }
  target.cents += cents;
  target.listPriceCents += cents;
}

export async function apiEquivalentByAgent(db: Db, companyId: string, range?: CostDateRange): Promise<Map<string | null, ApiEquivalent>> {
  const from = range?.from ? sql`and e.occurred_at >= ${range.from.toISOString()}::timestamptz` : sql``;
  const to = range?.to ? sql`and e.occurred_at <= ${range.to.toISOString()}::timestamptz` : sql``;
  const rows = await db.execute<Row>(sql`
    with ev as (
      select e.agent_id, e.model, e.billing_type, e.cost_status, e.cost_cents, e.heartbeat_run_id,
        e.idempotency_key = ('heartbeat:' || e.heartbeat_run_id::text || ':final') as final_receipt,
        e.idempotency_key like ('heartbeat:' || e.heartbeat_run_id::text || ':model:%') as model_receipt,
        case when e.receipt_hash is null and e.provider = 'openai' and e.model not like 'openai/_%'
          then greatest(0, e.input_tokens - e.cached_input_tokens) else e.input_tokens end as input_tokens,
        e.cached_input_tokens, e.output_tokens
      from cost_events e
      where e.company_id = ${companyId} ${from} ${to}
    ),
    priced as (
      select ev.*,
        case
          when ev.final_receipt then coalesce(r.usage_json->>'cacheAdjustedCostUsd', r.usage_json->>'costUsdExact', r.usage_json->>'costUsd')
          when ev.model_receipt then (select part->>'costUsd' from jsonb_array_elements(
              case when jsonb_typeof(r.usage_json->'usageByModel') = 'array' then r.usage_json->'usageByModel' else '[]'::jsonb end) part
            where part->>'model' = ev.model limit 1)
        end as reported_usd,
        case when ev.final_receipt and (r.usage_json->>'cacheWriteTokens') ~ '^[0-9]+$'
          then (r.usage_json->>'cacheWriteTokens')::numeric else 0 end as cache_write_tokens
      from ev
      left join heartbeat_runs r on r.id = ev.heartbeat_run_id and r.company_id = ${companyId}
    ),
    checked as (
      select *, case when trim(reported_usd) ~ ${DECIMAL_PATTERN} then trim(reported_usd)::numeric end as reported_amount
      from priced
    ),
    sourced as (
      select *,
        case
          when billing_type in ('subscription_included', 'subscription_overage') and reported_amount > 0 then 'reported'
          when billing_type in ('subscription_included', 'subscription_overage') or cost_status = 'unpriced' then 'table'
          else 'ledger'
        end as source
      from checked
    )
    select agent_id, model, source,
      coalesce(sum(cost_cents), 0)::text as cost_cents,
      coalesce(sum(case when source = 'reported' then reported_amount * 100 else 0 end), 0)::text as reported_cents,
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
