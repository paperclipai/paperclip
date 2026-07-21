import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents } from "@paperclipai/db";

// ── Types ──────────────────────────────────────────────────────────

export type UsageWindow = {
  start: Date;
  end: Date;
};

export type UsageSummary = {
  companyId: string;
  agentId: string | null;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  eventCount: number;
  byProvider: Record<string, { costCents: number; eventCount: number }>;
  byModel: Record<string, { costCents: number; eventCount: number }>;
  byBillingType: Record<string, { costCents: number; eventCount: number }>;
};

export type OverageResult = {
  includedAllowanceCents: number;
  actualCostCents: number;
  overageCents: number;
  overageMarkupCents: number;
  totalOverageCents: number;
  markupPercent: number;
};

export type TierConfig = {
  name: string;
  seatPriceCents: number | null;
  includedAllowanceCents: number;
  overageMarkupPercent: number;
};

// ── Tier defaults (from HOL-46 pricing strategy) ──────────────────

export const TIERS: Record<string, TierConfig> = {
  free: { name: "Free", seatPriceCents: 0, includedAllowanceCents: 0, overageMarkupPercent: 0 },
  pro: { name: "Pro", seatPriceCents: 2_000, includedAllowanceCents: 5_000, overageMarkupPercent: 15 },
  team: { name: "Team", seatPriceCents: 5_000, includedAllowanceCents: 20_000, overageMarkupPercent: 10 },
  enterprise: { name: "Enterprise", seatPriceCents: null, includedAllowanceCents: 0, overageMarkupPercent: 0 },
};

export type UsageBillingDisposition = "billable" | "customer_paid" | "needs_review";

export function classifyUsageBilling(billingType: string | null): UsageBillingDisposition {
  if (billingType === "metered_api") return "billable";
  if (billingType === "subscription_included" || billingType === "subscription_overage") {
    return "customer_paid";
  }
  return "needs_review";
}

export type BillingPreview = {
  tier: string;
  seatCount: number;
  subscriptionCents: number;
  includedAllowanceCents: number;
  managedUsageCents: number;
  overageCents: number;
  markupCents: number;
  projectedInvoiceCents: number;
  usageBilling: UsageBillingDisposition;
};

export function buildBillingPreview(input: {
  tier: string;
  seatCount: number;
  actualCostCents: number;
  usageBilling?: UsageBillingDisposition;
}): BillingPreview {
  const tier = TIERS[input.tier];
  if (!tier) throw new RangeError(`Unknown billing tier ${input.tier}`);
  if (tier.seatPriceCents === null) {
    throw new RangeError(`Tier ${input.tier} requires custom billing configuration`);
  }
  if (!Number.isInteger(input.seatCount) || input.seatCount < 1) {
    throw new RangeError("seatCount must be a positive integer");
  }
  const usageBilling = input.usageBilling ?? "billable";
  const managedUsageCents = usageBilling === "billable" ? input.actualCostCents : 0;
  const overage = calculateOverage(managedUsageCents, tier, input.seatCount);
  const subscriptionCents = tier.seatPriceCents * input.seatCount;
  return {
    tier: input.tier,
    seatCount: input.seatCount,
    subscriptionCents,
    includedAllowanceCents: overage.includedAllowanceCents,
    managedUsageCents,
    overageCents: overage.overageCents,
    markupCents: overage.overageMarkupCents,
    projectedInvoiceCents: subscriptionCents + overage.totalOverageCents,
    usageBilling,
  };
}

type StripeFetch = typeof fetch;

export function resolveStripePriceId(
  tier: "pro" | "team",
  billingCycle: "monthly" | "annual",
  env: Record<string, string | undefined> = process.env,
): string {
  const key = `STRIPE_PRICE_${tier.toUpperCase()}_${billingCycle.toUpperCase()}`;
  const priceId = env[key]?.trim();
  if (!priceId) throw new Error(`Missing ${key}`);
  return priceId;
}

async function postStripeForm<T>(
  path: string,
  secretKey: string,
  body: URLSearchParams,
  fetcher: StripeFetch,
): Promise<T> {
  const response = await fetcher(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = await response.json() as { error?: { message?: string } } & T;
  if (!response.ok) {
    throw new Error(`Stripe request failed (${response.status}): ${payload.error?.message ?? response.statusText}`);
  }
  return payload;
}

export function createCheckoutSession(input: {
  secretKey: string;
  priceId: string;
  companyId: string;
  seatCount: number;
  successUrl: string;
  cancelUrl: string;
  customerId?: string;
  fetcher?: StripeFetch;
}) {
  if (!Number.isInteger(input.seatCount) || input.seatCount < 1) {
    throw new RangeError("seatCount must be a positive integer");
  }
  const body = new URLSearchParams({
    mode: "subscription",
    client_reference_id: input.companyId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    "line_items[0][price]": input.priceId,
    "line_items[0][quantity]": String(input.seatCount),
    "subscription_data[metadata][company_id]": input.companyId,
  });
  if (input.customerId) body.set("customer", input.customerId);
  return postStripeForm<{ id: string; url: string | null }>(
    "checkout/sessions",
    input.secretKey,
    body,
    input.fetcher ?? fetch,
  );
}

export function createPortalSession(input: {
  secretKey: string;
  customerId: string;
  returnUrl: string;
  fetcher?: StripeFetch;
}) {
  return postStripeForm<{ url: string }>(
    "billing_portal/sessions",
    input.secretKey,
    new URLSearchParams({ customer: input.customerId, return_url: input.returnUrl }),
    input.fetcher ?? fetch,
  );
}

// ── Service ────────────────────────────────────────────────────────

export function calculateOverage(
  actualCostCents: number,
  tier: TierConfig,
  seatCount = 1,
): OverageResult {
  if (!Number.isInteger(seatCount) || seatCount < 1) {
    throw new RangeError("seatCount must be a positive integer");
  }
  const includedAllowanceCents = tier.includedAllowanceCents * seatCount;
  const overageCents = Math.max(0, actualCostCents - includedAllowanceCents);
  const overageMarkupCents = Math.round(overageCents * (tier.overageMarkupPercent / 100));
  return {
    includedAllowanceCents,
    actualCostCents,
    overageCents,
    overageMarkupCents,
    totalOverageCents: overageCents + overageMarkupCents,
    markupPercent: tier.overageMarkupPercent,
  };
}

export function usageMeteringService(db: Db) {
  /**
   * Aggregate usage for a company (optionally scoped to an agent) over a time window.
   */
  async function getUsage(
    companyId: string,
    window: UsageWindow,
    agentId?: string,
  ): Promise<UsageSummary> {
    const conditions = [
      eq(costEvents.companyId, companyId),
      gte(costEvents.occurredAt, window.start),
      lt(costEvents.occurredAt, window.end),
    ];
    if (agentId) conditions.push(eq(costEvents.agentId, agentId));

    const rows = await db
      .select({
        agentId: costEvents.agentId,
        provider: costEvents.provider,
        model: costEvents.model,
        billingType: costEvents.billingType,
        costCents: costEvents.costCents,
        inputTokens: costEvents.inputTokens,
        outputTokens: costEvents.outputTokens,
        cachedInputTokens: costEvents.cachedInputTokens,
      })
      .from(costEvents)
      .where(and(...conditions));

    const summary: UsageSummary = {
      companyId,
      agentId: agentId ?? null,
      totalCostCents: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedInputTokens: 0,
      eventCount: rows.length,
      byProvider: {},
      byModel: {},
      byBillingType: {},
    };

    for (const row of rows) {
      summary.totalCostCents += row.costCents;
      summary.totalInputTokens += row.inputTokens;
      summary.totalOutputTokens += row.outputTokens;
      summary.totalCachedInputTokens += row.cachedInputTokens;

      const provider = row.provider || "unknown";
      summary.byProvider[provider] ??= { costCents: 0, eventCount: 0 };
      summary.byProvider[provider].costCents += row.costCents;
      summary.byProvider[provider].eventCount++;

      const model = row.model || "unknown";
      summary.byModel[model] ??= { costCents: 0, eventCount: 0 };
      summary.byModel[model].costCents += row.costCents;
      summary.byModel[model].eventCount++;

      const billingType = row.billingType || "unknown";
      summary.byBillingType[billingType] ??= { costCents: 0, eventCount: 0 };
      summary.byBillingType[billingType].costCents += row.costCents;
      summary.byBillingType[billingType].eventCount++;
    }

    return summary;
  }

  /**
   * Detect BYO keys: check if any cost events for this company have billingType
   * other than "metered_api" (i.e., the user is using their own API keys).
   * Returns true if BYO keys are detected (skip usage billing).
   */
  async function detectBypassBilling(
    companyId: string,
    window: UsageWindow,
  ): Promise<boolean> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.occurredAt, window.start),
          lt(costEvents.occurredAt, window.end),
          sql`${costEvents.billingType} IS DISTINCT FROM 'metered_api'`,
        ),
      );
    return (row?.count ?? 0) > 0;
  }

  /**
   * Get per-agent usage breakdown for a company.
   */
  async function getPerAgentUsage(
    companyId: string,
    window: UsageWindow,
  ): Promise<Map<string, UsageSummary>> {
    const rows = await db
      .select({
        agentId: costEvents.agentId,
        provider: costEvents.provider,
        model: costEvents.model,
        billingType: costEvents.billingType,
        costCents: costEvents.costCents,
        inputTokens: costEvents.inputTokens,
        outputTokens: costEvents.outputTokens,
        cachedInputTokens: costEvents.cachedInputTokens,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.occurredAt, window.start),
          lt(costEvents.occurredAt, window.end),
        ),
      );

    const map = new Map<string, UsageSummary>();
    for (const row of rows) {
      let s = map.get(row.agentId);
      if (!s) {
        s = {
          companyId,
          agentId: row.agentId,
          totalCostCents: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCachedInputTokens: 0,
          eventCount: 0,
          byProvider: {},
          byModel: {},
          byBillingType: {},
        };
        map.set(row.agentId, s);
      }
      s.totalCostCents += row.costCents;
      s.totalInputTokens += row.inputTokens;
      s.totalOutputTokens += row.outputTokens;
      s.totalCachedInputTokens += row.cachedInputTokens;
      s.eventCount++;

      const p = row.provider || "unknown";
      s.byProvider[p] ??= { costCents: 0, eventCount: 0 };
      s.byProvider[p].costCents += row.costCents;
      s.byProvider[p].eventCount++;

      const m = row.model || "unknown";
      s.byModel[m] ??= { costCents: 0, eventCount: 0 };
      s.byModel[m].costCents += row.costCents;
      s.byModel[m].eventCount++;

      const bt = row.billingType || "unknown";
      s.byBillingType[bt] ??= { costCents: 0, eventCount: 0 };
      s.byBillingType[bt].costCents += row.costCents;
      s.byBillingType[bt].eventCount++;
    }
    return map;
  }

  return { getUsage, calculateOverage, detectBypassBilling, getPerAgentUsage };
}
