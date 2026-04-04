import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { trackErrorHandlerCrash } from "@penclipai/shared/telemetry";
import { HttpError } from "../errors.js";
import { translate as translateServer } from "../i18n.js";
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

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Express can still route an error here after another layer already committed
  // a response (for example a 304). In that case we must delegate instead of
  // trying to write a second response.
  if (res.headersSent) {
    next(err);
    return;
  }

  const translate = typeof req.t === "function"
    ? req.t
    : ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
        translateServer("en", key, params));

  if (err instanceof HttpError) {
    const translatedMessage = translate(err.message);
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
      error: translatedMessage,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: translate("errors.validation"), details: err.errors });
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

  res.status(500).json({ error: translate("errors.internalServer") });
  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });
}
