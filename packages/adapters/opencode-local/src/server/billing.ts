import { inferOpenAiCompatibleBiller, resolveManagedOpenAiBilling } from "@paperclipai/adapter-utils";
import { apiKeyBillingType } from "@paperclipai/adapter-utils/api-billing-type";

/** Use the trusted connection route, never OpenCode's synthetic model provider,
 * to identify managed API work. OpenCode's custom-model cost is a local estimate
 * (zero when rates are absent), not a provider billing receipt. */
export function resolveOpenCodeAccounting(
  routing: unknown,
  env: Record<string, string>,
  model: string | null,
  clientCostUsd: number | null,
) {
  const route = routing && typeof routing === "object" && !Array.isArray(routing)
    ? routing as Record<string, unknown> : null;
  if (route) {
    const managedBilling = resolveManagedOpenAiBilling(route)!;
    return {
      provider: "openai",
      biller: managedBilling.biller,
      billingType: route.auth === "none" ? "unknown" as const : "metered_api" as const,
      model: model?.startsWith("paperclip/") ? model.slice("paperclip/".length) : model,
      costUsd: null,
      costStatus: "unpriced" as const,
    };
  }
  const provider = model?.includes("/") ? model.slice(0, model.indexOf("/")).trim() || null : null;
  return {
    provider,
    biller: provider === "openai" ? inferOpenAiCompatibleBiller(env, "openai") ?? "unknown" : provider ?? "unknown",
    billingType: apiKeyBillingType(provider, env),
    model,
    costUsd: clientCostUsd,
    costStatus: clientCostUsd == null ? "unpriced" as const : undefined,
  };
}
