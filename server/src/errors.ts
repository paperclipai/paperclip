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

/**
 * 401 with a stable machine-readable default code so clients (and edge
 * proxies) can distinguish app-level authentication failures from
 * infrastructure blocks. Explicit `details` REPLACE the default wholesale
 * (no merging): callers that pass details should include their own `code`
 * when they need one — the central error handler still derives
 * `code: "unauthorized"` when they do not.
 */
export function unauthorized(message = "Unauthorized", details?: unknown) {
  return new HttpError(401, message, details ?? { code: "unauthorized" });
}

/**
 * 403 with a stable machine-readable default code. Same replace semantics
 * as `unauthorized`: explicit `details` win wholesale, and the central
 * error handler derives `code: "forbidden"` for detail objects without one.
 */
export function forbidden(message = "Forbidden", details?: unknown) {
  return new HttpError(403, message, details ?? { code: "forbidden" });
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

export function tooManyRequests(message = "Too many requests", details?: unknown) {
  return new HttpError(429, message, details);
}
