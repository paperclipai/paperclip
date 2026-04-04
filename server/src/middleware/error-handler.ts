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

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
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
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  // Defense-in-depth: catch http-errors style objects (e.g. from body-parser
  // verify callbacks) that have a numeric .status but are not HttpError.
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as any).status === "number" &&
    (err as any).status >= 400 &&
    (err as any).status < 600
  ) {
    const status = (err as any).status as number;
    const expose = (err as any).expose === true;
    const message =
      status < 500 && expose && (err as any).message
        ? (err as any).message
        : "Internal server error";
    if (status >= 500) {
      const rootErr = err instanceof Error ? err : new Error(String(err));
      attachErrorContext(req, res, { message: rootErr.message, stack: rootErr.stack, name: rootErr.name }, rootErr);
    }
    res.status(status).json({ error: message });
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

  res.status(500).json({ error: "Internal server error" });
}
