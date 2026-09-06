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

function responseHeader(
  headers: Headers | Record<string, unknown> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === target,
  );
  const value = entry?.[1];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function positiveNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
          adapter?: unknown;
          code?: unknown;
          retryAfter?: unknown;
          retryAfterMs?: unknown;
          retry_after?: unknown;
          status?: unknown;
          statusCode?: unknown;
          subCode?: unknown;
          providerCodes?: unknown;
          data?: { error?: unknown };
          response?: {
            status?: unknown;
            headers?: Headers | Record<string, unknown>;
          };
          originalError?: {
            code?: unknown;
            status?: unknown;
          };
          details?: {
            code?: unknown;
            providerStatus?: unknown;
            providerSubCode?: unknown;
            providerCodes?: unknown;
          };
          innerHttpError?: { statusCode?: unknown };
        })
      : null;
  const name = typeof value?.name === "string" ? value.name : "";
  const adapter =
    typeof value?.adapter === "string" ? value.adapter.toLowerCase() : "";
  const code = typeof value?.code === "string" ? value.code : "";
  const platformCode =
    typeof value?.data?.error === "string" ? value.data.error : "";
  const detailsCode =
    typeof value?.details?.code === "string" ? value.details.code : "";
  const discordProviderCode =
    typeof value?.originalError?.code === "number"
      ? value.originalError.code
      : null;
  const status = [
    value?.status,
    value?.statusCode,
    value?.response?.status,
    value?.innerHttpError?.statusCode,
    value?.details?.providerStatus,
  ].find((candidate): candidate is number => typeof candidate === "number");
  const teamsProviderCodes = [
    value?.subCode,
    value?.details?.providerSubCode,
    ...(Array.isArray(value?.providerCodes) ? value.providerCodes : []),
    ...(Array.isArray(value?.details?.providerCodes)
      ? value.details.providerCodes
      : []),
  ]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.toLowerCase());
  const reason = text(error);
  const retryAfterHeader = positiveNumber(
    responseHeader(value?.response?.headers, "retry-after"),
  );
  const rateLimitRemaining = responseHeader(
    value?.response?.headers,
    "x-ratelimit-remaining",
  );
  const rateLimitReset = positiveNumber(
    responseHeader(value?.response?.headers, "x-ratelimit-reset"),
  );
  const githubRateLimit =
    status === 403 &&
    (retryAfterHeader !== null ||
      rateLimitRemaining === "0" ||
      reason.toLowerCase().includes("secondary rate limit") ||
      reason.toLowerCase().includes("rate limit exceeded"));

  // Endpoint management owns the same lease as provider transport. Losing a
  // short contention race is a definite local pre-transport outcome, so it is
  // safe to retry automatically and must never be presented as an ambiguous
  // provider delivery.
  if (detailsCode === "chat_endpoint_credentials_busy") {
    return { kind: "retry", retryAfterMs: 1_000, reason };
  }

  if (
    name === "AdapterRateLimitError" ||
    name === "RateLimitError" ||
    code === "RATE_LIMITED" ||
    code === "slack_webapi_rate_limited_error" ||
    platformCode === "ratelimited" ||
    status === 429 ||
    githubRateLimit
  ) {
    const seconds = finitePositive(value?.retryAfter);
    const milliseconds = finitePositive(value?.retryAfterMs);
    const telegramSeconds = finitePositive(value?.retry_after);
    const resetMilliseconds = rateLimitReset
      ? Math.max(1_000, rateLimitReset * 1_000 - Date.now())
      : null;
    const headerSeconds = seconds ?? retryAfterHeader ?? telegramSeconds;
    return {
      kind: "retry",
      retryAfterMs: Math.min(
        15 * 60_000,
        milliseconds ??
          (headerSeconds !== null
            ? headerSeconds * 1000
            : (resetMilliseconds ?? 2 ** Math.max(0, attempt) * 1000)),
      ),
      reason,
    };
  }

  if (
    // Discord distinguishes a destination the bot cannot access (50001) or
    // cannot write to (50013) from invalid credentials and app-wide failures.
    // The pinned adapter preserves the bounded numeric API code on its nested
    // DiscordApiError. Quarantine only the affected channel/conversation;
    // generic Discord 403s and every 401 remain endpoint-scoped below.
    adapter === "discord" &&
    status === 403 &&
    (discordProviderCode === 50001 || discordProviderCode === 50013)
  ) {
    return { kind: "resource_unavailable", reason };
  }

  if (
    // Telegram uses 403 for destination-local conditions such as a user
    // blocking the bot or removing it from a chat. Its adapter deliberately
    // represents those responses as PermissionError while keeping an invalid
    // bot token as AuthenticationError (401). Quarantine only that
    // conversation/resource; the same bot may still serve every other chat.
    adapter === "telegram" &&
    name === "PermissionError" &&
    code === "PERMISSION_DENIED"
  ) {
    return { kind: "resource_unavailable", reason };
  }

  if (
    // A Teams app can remain healthy while Microsoft rejects writes to one
    // conversation after the bot is blocked, uninstalled, or loses access.
    // The pinned adapter preserves only bounded provider code tokens from the
    // 403 response body; never use the free-form message for this distinction.
    adapter === "teams" &&
    name === "PermissionError" &&
    code === "PERMISSION_DENIED" &&
    status === 403 &&
    teamsProviderCodes.some((providerCode) =>
      ["messagewritesblocked", "forbiddenoperationexception"].includes(
        providerCode,
      ),
    )
  ) {
    return { kind: "resource_unavailable", reason };
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
    status === 410 ||
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
    code === "NOT_IMPLEMENTED" ||
    // Paperclip rejected the destination locally before opening a provider
    // request, so delivery is definitively impossible rather than ambiguous.
    code === "CHAT_PROVIDER_PRETRANSPORT_REJECTED" ||
    // Adapter-contract drift is detected during runtime construction, before
    // any provider request can have been attempted.
    code === "CHAT_ADAPTER_COMPATIBILITY_ERROR"
  ) {
    return { kind: "failed", reason };
  }

  // Any remaining 4xx response is a definite provider rejection: the
  // provider returned an HTTP response and did not accept the operation.
  // Keep it out of delivery_unknown, which is reserved for requests whose
  // external side effect cannot be determined. Provider-specific repairable
  // cases (rate limits, auth, and missing destinations) were handled above.
  if (status !== undefined && status >= 400 && status < 500) {
    return { kind: "failed", reason };
  }

  // Adapter NetworkError and ordinary fetch/transport errors are ambiguous:
  // the request may have reached the provider even when no response reached
  // Paperclip. An operator must inspect the native conversation before replay.
  return { kind: "delivery_unknown", reason };
}
