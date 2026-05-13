export class HttpError extends Error {
  status: number;
  details?: unknown;
  code?: string;

  constructor(status: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

export function badRequest(message: string, details?: unknown, code?: string) {
  return new HttpError(400, message, details, code);
}

export function unauthorized(message = "Unauthorized", code?: string) {
  return new HttpError(401, message, undefined, code);
}

export function forbidden(message = "Forbidden", code?: string) {
  return new HttpError(403, message, undefined, code);
}

export function notFound(message = "Not found", code?: string) {
  return new HttpError(404, message, undefined, code);
}

export function conflict(message: string, details?: unknown, code?: string) {
  return new HttpError(409, message, details, code);
}

export function unprocessable(message: string, details?: unknown, code?: string) {
  return new HttpError(422, message, details, code);
}
