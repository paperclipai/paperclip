export type ChatPublicationErrorDisposition =
  | {
      kind: "retry";
      retryAfterMs: number;
      reason: string;
    }
  | {
      kind: "delivery_unknown";
      reason: string;
    }
  | {
      kind: "endpoint_attention";
      reason: string;
    }
  | {
      kind: "resource_unavailable";
      reason: string;
    }
  | {
      kind: "failed";
      reason: string;
    };

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a provider send failure by whether an external side effect could
 * already have happened. Only ambiguous network failures stop automatic
 * retry. Explicit provider rejections are safe to retry or repair without
 * risking a duplicate message.
 */
export function classifyChatPublicationError(
  error: unknown,
  attempt: number,
): ChatPublicationErrorDisposition {
  const value =
    error && typeof error === "object"
      ? (error as {
          name?: unknown;
          code?: unknown;
          retryAfter?: unknown;
          retryAfterMs?: unknown;
          retry_after?: unknown;
          status?: unknown;
          statusCode?: unknown;
          data?: { error?: unknown };
          response?: { status?: unknown };
          innerHttpError?: { statusCode?: unknown };
        })
      : null;
  const name = typeof value?.name === "string" ? value.name : "";
  const code = typeof value?.code === "string" ? value.code : "";
  const platformCode =
    typeof value?.data?.error === "string" ? value.data.error : "";
  const status = [
    value?.status,
    value?.statusCode,
    value?.response?.status,
    value?.innerHttpError?.statusCode,
  ].find((candidate): candidate is number => typeof candidate === "number");
  const reason = text(error);

  if (
    name === "AdapterRateLimitError" ||
    name === "RateLimitError" ||
    code === "RATE_LIMITED" ||
    code === "slack_webapi_rate_limited_error" ||
    platformCode === "ratelimited" ||
    status === 429
  ) {
    const seconds = finitePositive(value?.retryAfter);
    const milliseconds = finitePositive(value?.retryAfterMs);
    const telegramSeconds = finitePositive(value?.retry_after);
    return {
      kind: "retry",
      retryAfterMs: Math.min(
        15 * 60_000,
        milliseconds ??
          (seconds ?? telegramSeconds ?? 2 ** Math.max(0, attempt)) * 1000,
      ),
      reason,
    };
  }

  if (
    name === "AuthenticationError" ||
    name === "PermissionError" ||
    code === "AUTH_FAILED" ||
    code === "PERMISSION_DENIED" ||
    status === 401 ||
    status === 403 ||
    [
      "account_inactive",
      "invalid_auth",
      "missing_scope",
      "not_authed",
      "no_permission",
      "token_revoked",
    ].includes(platformCode)
  ) {
    return { kind: "endpoint_attention", reason };
  }

  if (
    name === "ResourceNotFoundError" ||
    code === "NOT_FOUND" ||
    status === 404 ||
    [
      "channel_not_found",
      "message_not_found",
      "not_in_channel",
      "thread_not_found",
    ].includes(platformCode) ||
    (name === "NetworkError" &&
      reason.toLowerCase().includes("resource not found during"))
  ) {
    return { kind: "resource_unavailable", reason };
  }

  if (
    name === "ValidationError" ||
    name === "NotImplementedError" ||
    code === "VALIDATION_ERROR" ||
    code === "NOT_IMPLEMENTED"
  ) {
    return { kind: "failed", reason };
  }

  // Adapter NetworkError and ordinary fetch/transport errors are ambiguous:
  // the request may have reached the provider even when no response reached
  // Paperclip. An operator must inspect the native conversation before replay.
  return { kind: "delivery_unknown", reason };
}
