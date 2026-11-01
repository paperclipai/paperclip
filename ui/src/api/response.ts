import { errorCopy, isTransientError, parseRetryAfter } from "./errors";

/** A proxy or restarting server answered an API request without usable JSON. */
export class ApiUnavailableError extends Error {
  constructor(
    public readonly status: number,
    /** Delay the gateway asked for with `Retry-After`, in milliseconds. */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(errorCopy("transient").body);
    this.name = "ApiUnavailableError";
  }
}

/**
 * Thin alias for `classifyError(error) === "transient"` (see `api/errors.ts`),
 * kept so existing callers such as `CloudAccessGate` pick up new transient
 * codes (`tenant_app_unavailable` in any status, 408/425/429) automatically.
 */
export function isTemporaryApiError(error: unknown): boolean {
  return isTransientError(error);
}

export async function readApiJson<T = unknown>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // An HTML fallback can have status 200 during a deployment. Never expose
    // its parser error or treat it as a successful, empty API response.
    if (response.ok || response.status >= 500) {
      throw new ApiUnavailableError(response.status, parseRetryAfter(response.headers?.get("Retry-After") ?? null));
    }
    // Preserve HTTP/auth error handling even when a 4xx response has no JSON.
    return null as T;
  }
}
