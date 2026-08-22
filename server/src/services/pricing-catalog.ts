import { and, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, costEvents } from "@paperclipai/db";

/**
 * The version a stored estimate is attributed to. It is bumped when a catalog
 * entry, an alias, or the arithmetic below changes, because a stamped row has
 * to stay re-derivable from the version it names. Runtime pricing lookups are
 * intentionally not used.
 */
export const PRICING_CATALOG_VERSION = "2026-08-19.v1";

type Price = { inputCentsPerMillion: number; cachedInputCentsPerMillion?: number; outputCentsPerMillion: number };

const CATALOG: Record<string, Price> = {
  "anthropic:claude-sonnet-4-5": { inputCentsPerMillion: 300, cachedInputCentsPerMillion: 30, outputCentsPerMillion: 1500 },
  "anthropic:claude-opus-4-1": { inputCentsPerMillion: 1500, cachedInputCentsPerMillion: 150, outputCentsPerMillion: 7500 },
  "openai:gpt-4o": { inputCentsPerMillion: 250, cachedInputCentsPerMillion: 125, outputCentsPerMillion: 1000 },
  "openai:gpt-4o-mini": { inputCentsPerMillion: 15, cachedInputCentsPerMillion: 8, outputCentsPerMillion: 60 },
  "openai:gpt-5": { inputCentsPerMillion: 125, cachedInputCentsPerMillion: 13, outputCentsPerMillion: 1000 },
  "google:gemini-2-5-pro": { inputCentsPerMillion: 125, cachedInputCentsPerMillion: 13, outputCentsPerMillion: 1000 },
};

const ALIASES: Record<string, string> = {
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929[1m]": "claude-sonnet-4-5",
  "claude-opus-4-1-20250805": "claude-opus-4-1",
  "gpt-4o-2024-05-13": "gpt-4o",
  "gpt-4o-mini-2024-07-18": "gpt-4o-mini",
};

export function normalizePricingIdentifier(value: string | null | undefined): string {
  return (value ?? "")
    .trim().toLowerCase().replace(/^models[/:]/, "").replace(/^anthropic[/:]/, "")
    .replace(/^openai[/:]/, "").replace(/^google[/:]/, "").replace(/\[1m\]$/, "")
    .replace(/\s+/g, "-");
}

/**
 * Whether a provider's reported input-token count already contains the cached
 * input tokens it reports beside it. The two categories are priced separately,
 * so this decides whether the cached count must be subtracted before the
 * uncached count is priced. Providers do not agree, and the adapters pass the
 * provider's own numbers through without normalizing them.
 *
 * - Anthropic reports `input_tokens` and `cache_read_input_tokens` as disjoint
 *   counts. Subtracting one from the other charges cache-heavy events at the
 *   cached rate for input they were billed for at the full rate.
 * - OpenAI reports cached tokens as a subset of `input_tokens`.
 * - Google reports `cachedContentTokenCount` inside `promptTokenCount`.
 *
 * A provider that is not listed is treated as inclusive, which is the safer of
 * the two defaults: it can only over-count cached tokens, never under-count the
 * spend of a provider whose counts are disjoint.
 */
const INPUT_EXCLUDES_CACHED: Record<string, true> = { anthropic: true };

export function resolveCatalogPrice(provider: string, biller: string | null | undefined, model: string) {
  const modelKey = ALIASES[normalizePricingIdentifier(model)] ?? normalizePricingIdentifier(model);
  const primaryProvider = normalizePricingIdentifier(provider || biller);
  const billerProvider = normalizePricingIdentifier(biller);
  const key = `${primaryProvider}:${modelKey}`;
  const price = CATALOG[key]
    ? { price: CATALOG[key], key, providerKey: primaryProvider }
    : CATALOG[`${billerProvider}:${modelKey}`]
      ? { price: CATALOG[`${billerProvider}:${modelKey}`], key, providerKey: billerProvider }
      : null;
  return price ? { ...price.price, key: price.key, providerKey: price.providerKey, catalogVersion: PRICING_CATALOG_VERSION } : null;
}

export function catalogCostCents(input: {
  provider: string; biller?: string | null; model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number;
}) {
  const price = resolveCatalogPrice(input.provider, input.biller, input.model);
  if (!price) return null;
  const uncachedInput = INPUT_EXCLUDES_CACHED[price.providerKey]
    ? input.inputTokens
    : Math.max(0, input.inputTokens - input.cachedInputTokens);
  const cents = (uncachedInput * price.inputCentsPerMillion
    + input.cachedInputTokens * (price.cachedInputCentsPerMillion ?? price.inputCentsPerMillion)
    + input.outputTokens * price.outputCentsPerMillion) / 1_000_000;
  return { costCents: Math.max(0, Math.ceil(cents)), pricingCatalogVersion: price.catalogVersion };
}

/**
 * The cost a new event is stored with, and whether that number came from the
 * provider or from the catalog.
 *
 * An estimate may replace an absence, never a charge. That is the precedence
 * `repairableRowCondition` applies to historical rows, and the two paths have
 * to agree: the writer prices exactly the rows the repair would price, and
 * leaves alone exactly the rows the repair refuses to touch.
 *
 * - A `subscription_included` event costs zero by contract. Its zero is a fact,
 *   not a gap, whatever status the caller stated beside it.
 * - A number the provider named is a charge, including one that rounds to zero
 *   at integer cents. `resolveLedgerCostStatus` writes `reported` whenever the
 *   provider named a cost, so a `reported` zero is authoritative and an
 *   estimate must not restate it.
 * - What is left named no cost while it used tokens, which is the case the
 *   catalog exists for. An unknown model stays unpriced rather than guessed.
 */
export function classifyCost(input: {
  provider: string; biller?: string | null; model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; costCents: number; billingType?: string | null; costStatus?: string | null;
}) {
  const stated = {
    costStatus: (input.costStatus === "unpriced" ? "unpriced" : "reported") as "unpriced" | "reported",
    pricingCatalogVersion: null,
    costCents: input.costCents,
  };
  if (input.billingType === "subscription_included") return { ...stated, costCents: 0 };
  if (input.costCents > 0 || input.costStatus === "reported") return stated;
  const estimated = catalogCostCents(input);
  return estimated ? { costStatus: "reported" as const, ...estimated } : { costStatus: "unpriced" as const, pricingCatalogVersion: null, costCents: 0 };
}

/**
 * The rows the repair is allowed to write.
 *
 * The repair estimates. An estimate may only replace an absence, never a
 * charge, so the same precedence `classifyCost` applies on the write path
 * decides eligibility here:
 *
 * - A row already attributed to a catalog version is left alone. Re-pricing it
 *   would silently restate spend that was recorded under a stated version.
 * - A row billed as `subscription_included` costs zero by contract. Its zero is
 *   a fact, not a gap.
 * - A row that carries a cost carries a number the provider reported.
 * - A row that states `reported` carries a number the provider reported even
 *   when that number is zero. `resolveLedgerCostStatus` writes `unpriced` when
 *   the provider named no cost and tokens were used, and `reported` in every
 *   other case, so a `reported` zero is a charge that rounded to zero at
 *   integer cents, not an absent price. Restating one would move stored spend
 *   for a charge the provider did name.
 *
 * What is left is a row that states it was never priced, carries no cost, and
 * names no catalog version, which is what the repair exists for. The first
 * version of this selected on `unpriced OR no version`, and every row written
 * before the migration has no version, so it took in the priced rows too.
 */
const repairableRowCondition = (companyId: string) => and(
  eq(costEvents.companyId, companyId),
  isNull(costEvents.pricingCatalogVersion),
  eq(costEvents.costStatus, "unpriced"),
  eq(costEvents.costCents, 0),
  ne(costEvents.billingType, "subscription_included"),
);

export async function repairHistoricalPricing(db: Db, input: { companyId: string; apply: boolean }) {
  const rows = await db.select().from(costEvents).where(repairableRowCondition(input.companyId));
  const matched: string[] = [];
  if (input.apply) {
    await db.transaction(async (tx) => {
      for (const row of rows) {
        const estimate = catalogCostCents(row);
        if (!estimate) continue;
        await tx.update(costEvents).set({ costCents: estimate.costCents, costStatus: "reported", pricingCatalogVersion: estimate.pricingCatalogVersion }).where(eq(costEvents.id, row.id));
        matched.push(row.id);
      }
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const agentTotals = await tx.select({ agentId: costEvents.agentId, total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)` }).from(costEvents).where(and(eq(costEvents.companyId, input.companyId), gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end))).groupBy(costEvents.agentId);
      for (const total of agentTotals) await tx.update(agents).set({ spentMonthlyCents: Number(total.total), updatedAt: now }).where(eq(agents.id, total.agentId));
      const [companyTotal] = await tx.select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)` }).from(costEvents).where(and(eq(costEvents.companyId, input.companyId), gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end)));
      await tx.update(companies).set({ spentMonthlyCents: Number(companyTotal?.total ?? 0), updatedAt: now }).where(eq(companies.id, input.companyId));
    });
  } else {
    for (const row of rows) if (catalogCostCents(row)) matched.push(row.id);
  }
  return { companyId: input.companyId, dryRun: !input.apply, catalogVersion: PRICING_CATALOG_VERSION, scanned: rows.length, confidentlyMatched: matched.length, updatedEventIds: input.apply ? matched : [] };
}
