import type { AiProvider } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { AI_KEY_VERIFICATION_FAILURES, type AiKeyVerificationFailure } from "./ai-api-key-failures.js";

const KNOWN_PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set([
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error", "request_too_large",
  "rate_limit_error", "api_error", "overloaded_error", "billing_error", "timeout_error",
  "insufficient_quota", "invalid_api_key", "rate_limit_exceeded", "server_error", "model_not_found", "insufficient_credits",
  "INVALID_ARGUMENT", "FAILED_PRECONDITION", "PERMISSION_DENIED", "UNAUTHENTICATED", "NOT_FOUND",
  "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED",
]);
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const BILLING_ERROR_TYPES = new Set(["billing_error", "insufficient_quota", "insufficient_credits"]);

async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES).toString("utf8");
}

async function providerErrorTypes(response: Response): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedBody(response));
  } catch {
    return [];
  }
  const error = parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object") return [];
  const { type, code, status } = error as { type?: unknown; code?: unknown; status?: unknown };
  return [type, code, status].filter((candidate): candidate is string =>
    typeof candidate === "string" && KNOWN_PROVIDER_ERROR_TYPES.has(candidate));
}

function classify(status: number, errorTypes: string[]): AiKeyVerificationFailure {
  if (status === 401 || status === 403) return "rejected";
  if (status === 402 || errorTypes.some(type => BILLING_ERROR_TYPES.has(type))) return "billing";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "unavailable";
  return "failed";
}

function fail(failure: AiKeyVerificationFailure): never {
  const { code, message } = AI_KEY_VERIFICATION_FAILURES[failure];
  throw unprocessable(message, { code });
}

/** Fixed provider endpoints; credentials are never sent to a caller-supplied URL or through a redirect. */
export async function validateAiApiKey(
  provider: AiProvider,
  key: string,
  request: typeof fetch = fetch,
) {
  if (provider === "github") throw unprocessable("Copilot requires verification in the selected execution environment.", { code: "copilot_environment_required" });
  const endpoints = {
    anthropic: "https://api.anthropic.com/v1/models?limit=1",
    openai: "https://api.openai.com/v1/models",
    openrouter: "https://openrouter.ai/api/v1/key",
    xai: "https://api.x.ai/v1/models",
    google: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
  };
  let response: Response;
  try {
    response = await request(endpoints[provider], {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers:
        provider === "google" ? { "x-goog-api-key": key } : provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${key}` },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause as { code?: unknown } : undefined;
    logger.warn({ provider, networkError: timedOut ? "timeout" : typeof cause?.code === "string" ? cause.code : "request_failed" },
      "AI provider API key verification request failed");
    fail(timedOut ? "timeout" : "unreachable");
  }
  if (response.ok) {
    await response.body?.cancel();
    return;
  }
  const errorTypes = response.status === 401 || response.status === 403 ? [] : await providerErrorTypes(response);
  if (response.status === 401 || response.status === 403) await response.body?.cancel();
  const failure = classify(response.status, errorTypes);
  const errorType = errorTypes.find(type => BILLING_ERROR_TYPES.has(type)) ?? errorTypes[0] ?? null;
  logger.warn({ provider, status: response.status, providerErrorType: errorType, failure: AI_KEY_VERIFICATION_FAILURES[failure].code },
    "AI provider did not verify an API key");
  fail(failure);
}
