export class HttpError extends Error {
  status: number;
  details?: unknown;
  headers?: Record<string, string>;

  constructor(
    status: number,
    message: string,
    details?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.details = details;
    this.headers = headers;
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

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

export function tooManyRequests(
  message: string,
  retryAfterSeconds?: number,
  details?: unknown,
) {
  const headers =
    typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
      ? { "Retry-After": String(Math.ceil(retryAfterSeconds)) }
      : undefined;
  return new HttpError(429, message, details, headers);
}
