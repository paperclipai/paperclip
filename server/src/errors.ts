export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Creates an HTTP 400 Bad Request error. */
export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

/** Creates an HTTP 401 Unauthorized error. */
export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

/** Creates an HTTP 403 Forbidden error. */
export function forbidden(message = "Forbidden") {
  return new HttpError(403, message);
}

/** Creates an HTTP 404 Not Found error. */
export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

/** Creates an HTTP 409 Conflict error. */
export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

/** Creates an HTTP 422 Unprocessable Entity error. */
export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}
