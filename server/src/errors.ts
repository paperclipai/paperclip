export class HttpError extends Error {
  status: number;
  details?: unknown;
  /** Top-level fields to spread into the JSON response body (alongside `error`). */
  flatDetails?: Record<string, unknown>;

  constructor(status: number, message: string, details?: unknown, flatDetails?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.details = details;
    this.flatDetails = flatDetails;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden") {
  return new HttpError(403, message);
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

/** Like `conflict`, but spreads `flatDetails` at the top level of the JSON response body. */
export function conflictWithFlatDetails(message: string, flatDetails: Record<string, unknown>) {
  return new HttpError(409, message, undefined, flatDetails);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}
