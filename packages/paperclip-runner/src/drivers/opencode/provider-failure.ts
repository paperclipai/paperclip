import { createProviderFailure } from "../provider-failure.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * OpenCode reports some upstream failures as an `UnknownError` whose message is
 * the provider's JSON error, for example OpenRouter's
 * `{"code":502,"message":"...","metadata":{"error_type":"provider_unavailable"}}`.
 * Read its status, type and message instead of presenting the raw body.
 */
function providerErrorEnvelope(message: string): { message?: string; httpStatus?: unknown; providerCode?: unknown } {
  if (message.length > 16_000) return {};
  let response: Record<string, unknown>;
  try { response = record(JSON.parse(message)); } catch { return {}; }
  const detail = Object.keys(record(response.error)).length ? record(response.error) : response;
  return {
    message: typeof detail.message === "string" && detail.message.trim() ? detail.message : undefined,
    httpStatus: detail.code,
    providerCode: record(detail.metadata).error_type,
  };
}

export function openCodeProviderFailure(error: Record<string, unknown>, provider: string,
  environment: NodeJS.ProcessEnv = {}) {
  const data = error.data && typeof error.data === "object" ? error.data as Record<string, unknown> : {};
  const message = typeof data.message === "string" ? data.message : error.message;
  if (typeof message !== "string") return null;
  const envelope = providerErrorEnvelope(message);
  return createProviderFailure({ provider, phase: "turn", message: envelope.message ?? message,
    httpStatus: data.statusCode ?? envelope.httpStatus,
    providerCode: data.code ?? envelope.providerCode ?? error.name, requestId: data.requestID,
    category: error.name === "ProviderAuthError" ? "authentication" : undefined, environment });
}
