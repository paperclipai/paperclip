export type ChatPublicationErrorDisposition =
  | {
      kind: "retry";
      retryAfterMs: number;
      /** True when the provider explicitly asked Paperclip to slow down. */
      providerRateLimit?: boolean;
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

// Node timers accept delays through 2^31-1 milliseconds. Keep the durable
// provider hint intact up to that boundary instead of turning an hour-long
// flood-control response into a rapid series of fifteen-minute retries.
const MAX_PROVIDER_RETRY_AFTER_MS = 2_147_000_000;

function retryAfterHeaderMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = positiveNumber(value);
  if (seconds !== null) return seconds * 1000;
  const absolute = Date.parse(value);
  if (!Number.isFinite(absolute)) return null;
  return Math.max(1, absolute - Date.now());
}

type StructuredProviderError = {
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
  cause?: unknown;
  original?: unknown;
  originalError?: unknown;
  details?: {
    code?: unknown;
    providerStatus?: unknown;
    providerSubCode?: unknown;
    providerCodes?: unknown;
  };
  innerHttpError?: { statusCode?: unknown };
};

/**
 * Adapters sometimes wrap the provider SDK error before it reaches the
 * durable outbox. Follow only the documented structured wrapper properties,
 * with a small depth and cycle guard, so provider codes survive without ever
 * classifying on free-form error text.
 */
function structuredProviderErrors(error: unknown): StructuredProviderError[] {
  const records: StructuredProviderError[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (
      !current ||
      current.depth > 4 ||
      !current.value ||
      typeof current.value !== "object" ||
      seen.has(current.value)
    ) {
      continue;
    }
    seen.add(current.value);
    const record = current.value as StructuredProviderError;
    records.push(record);
    for (const nested of [
      record.cause,
      record.original,
      record.originalError,
    ]) {
      pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return records;
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
  const values = structuredProviderErrors(error);
  const firstNumber = (select: (value: StructuredProviderError) => unknown) =>
    values
      .map(select)
      .find((candidate): candidate is number => typeof candidate === "number");
  const names = values
    .map((value) => value.name)
    .filter((candidate): candidate is string => typeof candidate === "string");
  const adapters = values
    .map((value) => value.adapter)
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.toLowerCase());
  const codes = values
    .map((value) => value.code)
    .filter((candidate): candidate is string => typeof candidate === "string");
  const platformCodes = values
    .map((value) => value.data?.error)
    .filter((candidate): candidate is string => typeof candidate === "string");
  const detailsCodes = values
    .map((value) => value.details?.code)
    .filter((candidate): candidate is string => typeof candidate === "string");
  const discordProviderCode =
    values
      .map((value) => value.code)
      .find(
        (candidate): candidate is number => typeof candidate === "number",
      ) ?? null;
  const status = values
    .flatMap((value) => [
      value.status,
      value.statusCode,
      value.response?.status,
      value.innerHttpError?.statusCode,
      value.details?.providerStatus,
    ])
    .find((candidate): candidate is number => typeof candidate === "number");
  const teamsProviderCodes = values
    .flatMap((value) => [
      value.subCode,
      value.details?.providerSubCode,
      ...(Array.isArray(value.providerCodes) ? value.providerCodes : []),
      ...(Array.isArray(value.details?.providerCodes)
        ? value.details.providerCodes
        : []),
    ])
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.toLowerCase());
  const reason = text(error);
  const responseHeaders = values
    .map((value) => value.response?.headers)
    .find((headers) => headers !== undefined);
  const retryAfterHeaderMs = retryAfterHeaderMilliseconds(
    responseHeader(responseHeaders, "retry-after"),
  );
  const rateLimitRemaining = responseHeader(
    responseHeaders,
    "x-ratelimit-remaining",
  );
  const rateLimitReset = positiveNumber(
    responseHeader(responseHeaders, "x-ratelimit-reset"),
  );
  const githubRateLimit =
    status === 403 &&
    (retryAfterHeaderMs !== null ||
      rateLimitRemaining === "0" ||
      reason.toLowerCase().includes("secondary rate limit") ||
      reason.toLowerCase().includes("rate limit exceeded"));

  // Endpoint management owns the same lease as provider transport. Losing a
  // short contention race is a definite local pre-transport outcome, so it is
  // safe to retry automatically and must never be presented as an ambiguous
  // provider delivery.
  if (detailsCodes.includes("chat_endpoint_credentials_busy")) {
    return { kind: "retry", retryAfterMs: 1_000, reason };
  }

  if (
    names.includes("AdapterRateLimitError") ||
    names.includes("RateLimitError") ||
    codes.includes("RATE_LIMITED") ||
    codes.includes("slack_webapi_rate_limited_error") ||
    platformCodes.includes("ratelimited") ||
    status === 429 ||
    githubRateLimit
  ) {
    const seconds = finitePositive(firstNumber((value) => value.retryAfter));
    const milliseconds = finitePositive(
      firstNumber((value) => value.retryAfterMs),
    );
    const telegramSeconds = finitePositive(
      firstNumber((value) => value.retry_after),
    );
    const resetMilliseconds = rateLimitReset
      ? Math.max(1_000, rateLimitReset * 1_000 - Date.now())
      : null;
    const structuredSeconds = seconds ?? telegramSeconds;
    return {
      kind: "retry",
      retryAfterMs: Math.min(
        MAX_PROVIDER_RETRY_AFTER_MS,
        milliseconds ??
          (structuredSeconds !== null
            ? structuredSeconds * 1000
            : retryAfterHeaderMs !== null
              ? retryAfterHeaderMs
              : (resetMilliseconds ?? 2 ** Math.max(0, attempt) * 1000)),
      ),
      providerRateLimit: true,
      reason,
    };
  }

  if (
    // Discord distinguishes a destination the bot cannot access (50001) or
    // cannot write to (50013) from invalid credentials and app-wide failures.
    // The pinned adapter preserves the bounded numeric API code on its nested
    // DiscordApiError. Quarantine only the affected channel/conversation;
    // generic Discord 403s and every 401 remain endpoint-scoped below.
    adapters.includes("discord") &&
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
    adapters.includes("telegram") &&
    names.includes("PermissionError") &&
    codes.includes("PERMISSION_DENIED")
  ) {
    return { kind: "resource_unavailable", reason };
  }

  if (
    // A Teams app can remain healthy while Microsoft rejects writes to one
    // conversation after the bot is blocked, uninstalled, or loses access.
    // The pinned adapter preserves only bounded provider code tokens from the
    // 403 response body; never use the free-form message for this distinction.
    adapters.includes("teams") &&
    names.includes("PermissionError") &&
    codes.includes("PERMISSION_DENIED") &&
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
    names.includes("AuthenticationError") ||
    names.includes("PermissionError") ||
    codes.includes("AUTH_FAILED") ||
    codes.includes("PERMISSION_DENIED") ||
    status === 401 ||
    status === 403 ||
    [
      "account_inactive",
      "invalid_auth",
      "missing_scope",
      "not_authed",
      "no_permission",
      "token_revoked",
    ].some((platformCode) => platformCodes.includes(platformCode))
  ) {
    return { kind: "endpoint_attention", reason };
  }

  if (
    names.includes("ResourceNotFoundError") ||
    codes.includes("NOT_FOUND") ||
    status === 404 ||
    status === 410 ||
    [
      "channel_not_found",
      "channel_is_archived",
      "is_archived",
      "message_not_found",
      "not_in_channel",
      "thread_not_found",
    ].some((platformCode) => platformCodes.includes(platformCode)) ||
    (names.includes("NetworkError") &&
      reason.toLowerCase().includes("resource not found during"))
  ) {
    return { kind: "resource_unavailable", reason };
  }

  if (
    names.includes("ValidationError") ||
    names.includes("NotImplementedError") ||
    codes.includes("VALIDATION_ERROR") ||
    codes.includes("NOT_IMPLEMENTED") ||
    // Paperclip rejected the destination locally before opening a provider
    // request, so delivery is definitively impossible rather than ambiguous.
    codes.includes("CHAT_PROVIDER_PRETRANSPORT_REJECTED") ||
    // Adapter-contract drift is detected during runtime construction, before
    // any provider request can have been attempted.
    codes.includes("CHAT_ADAPTER_COMPATIBILITY_ERROR")
  ) {
    return { kind: "failed", reason };
  }

  // Slack WebClient platform errors represent a completed, structured API
  // rejection even though the SDK does not expose an HTTP status. Unknown
  // platform codes are therefore definite failures, not ambiguous delivery.
  if (codes.includes("slack_webapi_platform_error")) {
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
