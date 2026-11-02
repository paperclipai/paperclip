import { z } from "zod";
import { exactCentsSchema } from "./accounting.js";
import { centsToUnits, unitsToCents } from "./money.js";

export const SUBSCRIPTION_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "CHF"] as const;
export const subscriptionPriceSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  plan: z.string().trim().min(1).max(100),
  amountCents: exactCentsSchema.nullable(),
  currency: z.enum(SUBSCRIPTION_CURRENCIES),
  cadence: z.enum(["month", "year"]),
  status: z.enum(["active", "ended", "excluded"]),
}).strict();
export type UpdateSubscriptionPrice = z.input<typeof subscriptionPriceSchema>;
export const mergeSubscriptionsSchema = z.object({
  targetId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  targetRevision: z.number().int().nonnegative(),
}).strict();

export interface SubscriptionPlan {
  id: string;
  provider: string;
  name: string;
  monthlyCents: string;
  currency: "USD";
  sourceUrl: string;
  checkedAt: string;
}

// Web list prices, before tax, assuming monthly billing. These are estimates,
// never invoices. Generic Pro/Max/team entitlements do not identify a price.
export const SUBSCRIPTION_PLANS: readonly SubscriptionPlan[] = [
  ["openai", "free", "ChatGPT Free", "0", "https://learn.chatgpt.com/docs/pricing"],
  ["openai", "go", "ChatGPT Go", "800", "https://learn.chatgpt.com/docs/pricing"],
  ["openai", "plus", "ChatGPT Plus", "2000", "https://learn.chatgpt.com/docs/pricing"],
  ["anthropic", "pro", "Claude Pro", "2000", "https://claude.com/pricing"],
  ["anthropic", "max_5x", "Claude Max 5x", "10000", "https://claude.com/pricing"],
  ["anthropic", "max_20x", "Claude Max 20x", "20000", "https://claude.com/pricing"],
  ["xai", "supergrok", "SuperGrok", "3000", "https://x.ai/pricing"],
  ["xai", "supergrok_plus", "SuperGrok Plus", "10000", "https://x.ai/pricing"],
].map(([provider, id, name, monthlyCents, sourceUrl]) => ({
  provider, id, name, monthlyCents, sourceUrl, currency: "USD", checkedAt: "2026-10-08",
}));

export function subscriptionPlan(provider: string, plan: string | null): SubscriptionPlan | null {
  const key = plan?.trim().toLowerCase().replaceAll(" ", "_");
  return SUBSCRIPTION_PLANS.find(item => item.provider === provider && item.id === key) ?? null;
}

export function monthlySubscriptionCents(amount: string, cadence: "month" | "year"): string {
  const units = centsToUnits(amount);
  return unitsToCents(cadence === "year" ? (units + 6n) / 12n : units);
}

export interface SubscriptionPrice {
  revision: number;
  plan: string;
  amountCents: string | null;
  monthlyCents: string | null;
  currency: string;
  cadence: "month" | "year";
  status: "active" | "ended" | "excluded";
  source: "catalog" | "user" | "unknown";
  sourceUrl: string | null;
  effectiveAt: string;
}

export interface SubscriptionUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: string;
  eventCount: number;
  estimatedEventCount: number;
  unpricedEventCount: number;
}

export interface SubscriptionAccountReport {
  id: string;
  provider: string;
  name: string;
  ownerUserId: string | null;
  ownerName: string | null;
  shared: boolean;
  identityVerified: boolean;
  detectedPlan: string | null;
  observedAt: string | null;
  lastCheckedAt: string | null;
  refreshStatus: "ok" | "unavailable" | null;
  canEdit: boolean;
  price: SubscriptionPrice;
  usage: SubscriptionUsage;
  agents: { id: string; name: string }[];
}

export interface SubscriptionCostReport {
  canRefresh: boolean;
  /** Current monthly commitment for accounts visible to the caller;
   * independent of the usage date filter. Aggregate run usage is company-wide. */
  asOf: string;
  accounts: SubscriptionAccountReport[];
  monthlyTotals: { currency: string; amountCents: string; estimatedCount: number }[];
  activeCount: number;
  unknownPriceCount: number;
  unidentifiedAccountCount: number;
  api: SubscriptionUsage;
  subscription: SubscriptionUsage;
  /** Other billing types (credits, fixed, or unknown), outside API/subscription totals. */
  unknown: SubscriptionUsage;
  unattributedSubscription: SubscriptionUsage;
}
