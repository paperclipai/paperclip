/**
 * HTTP-aware error types for the MCP transport.
 *
 * Authenticators and request handlers throw these to control the status code
 * returned to the client. Anything that is not an {@link HttpError} is treated
 * as an internal (500) error by the runner.
 */

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

/** 401 — the caller could not be authenticated (bad/missing/unknown token). */
export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(message, 401);
    this.name = "UnauthorizedError";
  }
}

/**
 * 500 — the caller authenticated but the server-side binding is malformed
 * (e.g. an SSM parameter that is not valid JSON or is missing required fields).
 * Distinct from {@link UnauthorizedError} so operators can tell a rejected
 * token apart from a misconfigured one.
 */
export class TokenBindingError extends HttpError {
  constructor(message = "Invalid token binding") {
    super(message, 500);
    this.name = "TokenBindingError";
  }
}

/** Resolve the HTTP status to report for a thrown value, defaulting to 500. */
export function statusForError(error: unknown, fallback = 500): number {
  return error instanceof HttpError ? error.statusCode : fallback;
}

/** Best-effort human message for a thrown value. */
export function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
