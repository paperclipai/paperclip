import { HttpError } from "../../../errors.js";

export const GITHUB_PUBLICATION_MAX_ATTEMPTS = 8;
export const GITHUB_INLINE_RETRY_WINDOW_MS = 45_000;
export const GITHUB_INLINE_MAX_ATTEMPTS = 3;

export function githubRetryDelay(attempt: number) {
  return (
    Math.min(300_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250)
  );
}

export function githubProviderRetry(
  response: Response,
  secondaryRateLimit = false,
) {
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0" ||
        secondaryRateLimit));
  const retryable =
    rateLimited || response.status === 408 || response.status >= 500;
  const value = response.headers.get("retry-after");
  const seconds = value === null ? NaN : Number(value);
  const retryAfter = value === null ? NaN : Date.parse(value);
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const retryAfterMs =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : Number.isFinite(retryAfter)
        ? Math.max(0, retryAfter - Date.now())
        : 0;
  const resetMs =
    response.headers.get("x-ratelimit-remaining") === "0" &&
    Number.isFinite(reset)
      ? Math.max(0, reset * 1000 - Date.now())
      : 0;
  return {
    code: rateLimited
      ? "github_bot_rate_limited"
      : "github_bot_operation_failed",
    providerStatus: response.status,
    retryable,
    retryAfterMs: Math.max(
      retryAfterMs,
      resetMs,
      rateLimited && !retryAfterMs && !resetMs ? 60_000 : 0,
    ),
  };
}

export function githubPublicationRetry(error: unknown, attempts: number) {
  const details =
    error instanceof HttpError &&
    error.details &&
    typeof error.details === "object"
      ? (error.details as {
          retryable?: boolean;
          retryAfterMs?: number;
          providerStatus?: number;
        })
      : null;
  const retryable =
    attempts < GITHUB_PUBLICATION_MAX_ATTEMPTS &&
    (details?.retryable ?? !(error instanceof HttpError && error.status < 500));
  return {
    attempts,
    retryable,
    retryAt: new Date(
      Date.now() +
        Math.max(githubRetryDelay(attempts), details?.retryAfterMs ?? 0),
    ).toISOString(),
    ...(details?.providerStatus
      ? { providerStatus: details.providerStatus }
      : {}),
  };
}
