export class HttpError extends Error {
  status: number;
  details?: unknown;
  /** Optional i18n translation key for the error message. */
  i18nKey?: string;

  constructor(status: number, message: string, details?: unknown, i18nKey?: string) {
    super(message);
    this.status = status;
    this.details = details;
    this.i18nKey = i18nKey;
  }
}

export function badRequest(message: string, details?: unknown, i18nKey?: string) {
  return new HttpError(400, message, details, i18nKey);
}

export function unauthorized(message = "Unauthorized", i18nKey = "errors.common.unauthorized") {
  return new HttpError(401, message, undefined, i18nKey);
}

export function forbidden(message = "Forbidden", i18nKey = "errors.common.forbidden") {
  return new HttpError(403, message, undefined, i18nKey);
}

export function notFound(message = "Not found", i18nKey = "errors.common.notFound") {
  return new HttpError(404, message, undefined, i18nKey);
}

export function conflict(message: string, details?: unknown, i18nKey?: string) {
  return new HttpError(409, message, details, i18nKey);
}

export function unprocessable(message: string, details?: unknown, i18nKey?: string) {
  return new HttpError(422, message, details, i18nKey);
}
