import { sql } from "drizzle-orm";
import { costEvents } from "@paperclipai/db";
import { MODEL_PRICING } from "@paperclipai/shared";

// Per-token rate (cents/token) selected by model, generated from the shared
// MODEL_PRICING map so SQL imputation and the TS imputeCostCents() helper stay
// in sync from a single source. First matching substring wins (CASE order).
function modelRateCase(field: "inputPer1M" | "cachedInputPer1M" | "outputPer1M") {
  const specific = MODEL_PRICING.filter((price) => price.match !== "");
  const fallback =
    (MODEL_PRICING.find((price) => price.match === "") ?? MODEL_PRICING[MODEL_PRICING.length - 1])[field] /
    1_000_000;
  const whens = specific.map(
    (price) => sql`when lower(${costEvents.model}) like ${`%${price.match}%`} then ${price[field] / 1_000_000}::numeric`,
  );
  return sql`case ${sql.join(whens, sql` `)} else ${fallback}::numeric end`;
}

/**
 * SUM of the economic "truth" per cost_events row: the real billed cost when
 * reported (metered API), otherwise the imputed token cost (subscription runs
 * report cost_cents=0). Mirrors effectiveCostCents() from @paperclipai/shared.
 * Shared by the cost views and by budget enforcement so both govern the same
 * number for subscription usage.
 */
export function effectiveCostCentsSum() {
  return sql<number>`coalesce(sum(
    case when ${costEvents.costCents} > 0 then ${costEvents.costCents}
    else round(
      ${costEvents.inputTokens} * (${modelRateCase("inputPer1M")})
      + ${costEvents.cachedInputTokens} * (${modelRateCase("cachedInputPer1M")})
      + ${costEvents.outputTokens} * (${modelRateCase("outputPer1M")})
    ) end
  ), 0)::double precision`;
}
