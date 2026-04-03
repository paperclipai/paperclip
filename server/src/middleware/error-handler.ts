import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

/**
 * Translate an error message if a translation function is available on the request.
 * If the message matches a known i18n key (stored on the HttpError), use it;
 * otherwise fall back to the original message.
 */
function translateMessage(req: Request, message: string, i18nKey?: string): string {
  if (!req.t) return message;
  if (i18nKey) {
    const translated = req.t(i18nKey);
    // i18next returns the key itself when no translation is found
    if (translated !== i18nKey) return translated;
  }
  return message;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    const message = translateMessage(req, err.message, err.i18nKey);
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    res.status(err.status).json({
      error: message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    const message = req.t
      ? req.t("errors.common.validationError")
      : "Validation error";
    res.status(400).json({ error: message, details: err.errors });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });

  const message = req.t
    ? req.t("errors.common.internalServerError")
    : "Internal server error";
  res.status(500).json({ error: message });
}
