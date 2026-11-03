import type { ProviderFailure } from "../../contracts/provider-failure.generated.js";
import { createProviderFailure } from "../provider-failure.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function codexProviderFailure(value: unknown, phase: ProviderFailure["phase"], environment: NodeJS.ProcessEnv = {}): ProviderFailure | null {
  const error = record(value);
  if (typeof error.message !== "string") return null;
  let response: Record<string, unknown> = {};
  if (error.message.length <= 16_000) {
    try { response = record(JSON.parse(error.message)); } catch {}
  }
  const detail = record(response.error);
  const info = error.codexErrorInfo;
  const kind = typeof info === "string" ? info : Object.keys(record(info))[0];
  const code = detail.code ?? detail.type ?? kind;
  const categories: Record<string, ProviderFailure["category"]> = {
    usageLimitExceeded: "quota_exhausted", insufficient_quota: "quota_exhausted",
    credit_balance_exhausted: "quota_exhausted", organization_spend_limit_exceeded: "quota_exhausted",
    project_spend_limit_exceeded: "quota_exhausted", organization_usage_limit_exceeded: "quota_exhausted",
    rate_limit_exceeded: "rate_limit", rate_limit_error: "rate_limit", slow_down: "rate_limit",
    serverOverloaded: "overloaded", server_is_overloaded: "overloaded", unauthorized: "authentication",
    invalid_api_key: "authentication", model_not_found: "model_unavailable",
  };
  return createProviderFailure({ provider: "openai", phase,
    message: typeof detail.message === "string" ? detail.message : error.message,
    category: typeof code === "string" ? categories[code] : undefined,
    providerCode: code, httpStatus: response.status ?? record(record(info)[kind ?? ""]).httpStatusCode,
    requestId: response.request_id, environment });
}
