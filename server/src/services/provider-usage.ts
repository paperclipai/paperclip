import { centsToUnits, unitsToCents } from "@paperclipai/shared";
import type { DecisionProviderReceipt } from "./decision-model-provider.js";

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const count = (v: unknown) =>
  typeof v === "number" &&
  Number.isSafeInteger(v) &&
  v >= 0 &&
  v <= 2_147_483_647
    ? v
    : null;
export function providerUsageReceipt(result?: unknown): DecisionProviderReceipt {
  const value = object(result),
    usage = object(value.usage),
    response = object(value.response);
  const providerUsage = object(
    object(object(value.providerMetadata).openrouter).usage,
  );
  const raw = object(object(response.body).usage);
  const cost = providerUsage.cost ?? raw.cost ?? object(usage.raw).cost;
  return {
    inputTokens:
      count(usage.inputTokens) ?? count(object(usage.inputTokens).total),
    outputTokens:
      count(usage.outputTokens) ?? count(object(usage.outputTokens).total),
    providerRequestId:
      typeof response.id === "string" ? response.id.slice(0, 250) : null,
    costCents:
      typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? unitsToCents(centsToUnits(cost * 100))
        : null,
    costStatus:
      typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? "reported"
        : "unpriced",
    pricingProvenance: {
      source:
        typeof cost === "number" && Number.isFinite(cost) && cost >= 0
          ? "provider_reported"
          : "unknown",
    },
  };
}
