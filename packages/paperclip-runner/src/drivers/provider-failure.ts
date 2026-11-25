import { readProviderFailure, type ProviderFailure } from "../contracts/provider-failure.generated.js";
import { redactProviderDiagnostic } from "./diagnostic-redaction.js";

export function providerFailureMessage(message: string, environment: NodeJS.ProcessEnv = {}): string {
  const secrets = Object.entries(environment).flatMap(([key, value]) =>
    value && /token|secret|password|api[_-]?key|authorization|credential|otlp.*headers/i.test(key)
      ? [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)] : []).sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  return [...redactProviderDiagnostic(message)
    .replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+)\b/g, "[REDACTED]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")]
    .slice(0, 4000).join("").trim();
}

export function createProviderFailure(input: {
  provider: string;
  phase: ProviderFailure["phase"];
  message: string;
  category?: ProviderFailure["category"];
  providerCode?: unknown;
  httpStatus?: unknown;
  requestId?: unknown;
  retryAt?: unknown;
  environment?: NodeJS.ProcessEnv;
}): ProviderFailure | null {
  const httpStatus = typeof input.httpStatus === "number" && Number.isInteger(input.httpStatus)
    && input.httpStatus >= 400 && input.httpStatus <= 599 ? input.httpStatus : undefined;
  const category = input.category ?? (httpStatus === 429 ? "rate_limit" : httpStatus === 401 ? "authentication"
    : httpStatus === 403 ? "permission" : httpStatus === 503 || httpStatus === 529 ? "overloaded"
      : httpStatus === 408 || httpStatus === 504 ? "timeout" : "unknown");
  const retryAt = typeof input.retryAt === "string" && Number.isFinite(Date.parse(input.retryAt))
    ? new Date(input.retryAt).toISOString() : undefined;
  const token = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value)
    && providerFailureMessage(value, input.environment) === value ? value : undefined;
  return readProviderFailure({
    schema: "paperclip.provider-failure.v1", provider: token(input.provider)?.slice(0, 80) ?? "unknown", phase: input.phase,
    category, message: providerFailureMessage(input.message, input.environment),
    ...(token(input.providerCode) ? { providerCode: token(input.providerCode) } : {}),
    ...(token(input.requestId) ? { requestId: token(input.requestId) } : {}),
    ...(httpStatus ? { httpStatus } : {}), ...(retryAt ? { retryAt } : {}),
    retryability: ["authentication", "permission", "quota_exhausted", "model_unavailable", "invalid_request"].includes(category)
      ? "requires_action" : ["overloaded", "timeout"].includes(category) || (category === "rate_limit" && retryAt)
        ? "transient" : "unknown",
  });
}

export function providerFailureFromError(error: unknown, depth = 0): ProviderFailure | null {
  if (!error || typeof error !== "object" || depth > 5) return null;
  const value = error as Record<string, unknown>;
  const result = value.runnerCommandResult as Record<string, unknown> | undefined;
  const detail = result?.result as Record<string, unknown> | undefined;
  const direct = readProviderFailure(value.providerFailure) ?? readProviderFailure(detail?.providerFailure);
  if (direct) return direct;
  return providerFailureFromError(value.cause, depth + 1)
    ?? (Array.isArray(value.errors) ? value.errors.slice(0, 3).map(item => providerFailureFromError(item, depth + 1)).find(Boolean) ?? null : null);
}
