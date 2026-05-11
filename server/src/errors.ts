export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class AppError extends Error {
  statusCode: number;
  userMessage: string;
  internalMessage: string;

  constructor(opts: { userMessage: string; internalMessage: string; statusCode?: number }) {
    super(opts.internalMessage);
    this.userMessage = opts.userMessage;
    this.internalMessage = opts.internalMessage;
    this.statusCode = opts.statusCode ?? 500;
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
