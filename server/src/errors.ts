export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden", details?: unknown) {
  return new HttpError(403, message, details);
}

export function notFound(message = "Not found", details?: unknown) {
  return new HttpError(404, message, details);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function payloadTooLarge(message: string, details?: unknown) {
  return new HttpError(413, message, details);
}

export function unsupportedMediaType(message: string, details?: unknown) {
  return new HttpError(415, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

export function tooManyRequests(message = "Too many requests", details?: unknown) {
  return new HttpError(429, message, details);
}

export function serviceUnavailable(message = "Service temporarily unavailable") {
  return new HttpError(503, message);
}

// Transient DB-connection errors are NOT bugs: the embedded Postgres bounces during server
// reloads/restarts (the DB single-point-of-failure), so in-flight queries die with
// CONNECTION_CLOSED / "the database system is shutting down". These should map to a retryable
// 503 (so polling clients ride through), never a 500. Matches by client/PG error code or
// message, recursing through the DrizzleQueryError -> PostgresError `cause` chain.
const TRANSIENT_DB_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECTION_CONNECT_TIMEOUT",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (database system is starting up / shutting down)
]);

const TRANSIENT_DB_ERROR_PATTERNS = [
  "the database system is shutting down",
  "the database system is starting up",
  "connection_closed",
  "connection terminated",
  "connection ended",
  "terminating connection",
];

export function isTransientDbError(err: unknown, depth = 0): boolean {
  if (err == null || depth > 5) return false;
  const error = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof error.code === "string" && TRANSIENT_DB_ERROR_CODES.has(error.code)) return true;
  if (typeof error.message === "string") {
    const msg = error.message.toLowerCase();
    if (TRANSIENT_DB_ERROR_PATTERNS.some((pattern) => msg.includes(pattern))) return true;
  }
  return error.cause != null && isTransientDbError(error.cause, depth + 1);
}
