import { apiErrorMessage, parseRetryAfter } from "./errors";

export interface ApiErrorOptions {
  /** Raw server error code; defaults to `body.error` when that is a string. */
  code?: string | null;
  /** Server-requested delay from the `Retry-After` header, in milliseconds. */
  retryAfterMs?: number | null;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  /**
   * The raw `body.error` string (for example `tenant_app_unavailable`). Match
   * on this, never on `message`: `message` is readable copy for people and may
   * differ from the code (see `apiErrorMessage` in `api/errors.ts`).
   */
  code: string | null;
  retryAfterMs: number | null;

  constructor(message: string, status: number, body: unknown, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    const rawError = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    this.code = options.code !== undefined ? options.code : typeof rawError === "string" ? rawError : null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Build the `ApiError` for a non-OK response whose body has been read. */
export function apiErrorFromResponse(res: Response, body: unknown): ApiError {
  return new ApiError(apiErrorMessage(res.status, body), res.status, body, {
    retryAfterMs: parseRetryAfter(res.headers?.get("Retry-After") ?? null),
  });
}
