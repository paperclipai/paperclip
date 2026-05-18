import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError, AppError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  requestId: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  requestId: string,
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    requestId,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

const SAFE_STATUS_MESSAGES: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Resource not found",
  409: "Conflict",
  422: "Validation error",
};

function safeMessageForStatus(status: number): string {
  return SAFE_STATUS_MESSAGES[status] ?? (status >= 500 ? "An unexpected error occurred" : "Request error");
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const requestId = randomUUID();

  if (err instanceof AppError) {
    console.error(`[${requestId}] AppError (${err.statusCode}):`, err.internalMessage, err.stack);
    attachErrorContext(
      req,
      res,
      { message: err.internalMessage, stack: err.stack, name: err.name },
      requestId,
      err,
    );
    if (err.statusCode >= 500) {
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    res.status(err.statusCode).json({ error: err.userMessage, requestId });
    return;
  }

  if (err instanceof HttpError) {
    const safeMessage = safeMessageForStatus(err.status);
    console.error(`[${requestId}] HttpError (${err.status}):`, err.message, err.stack);
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        requestId,
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    res.status(err.status).json({
      error: safeMessage,
      requestId,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    console.error(`[${requestId}] ZodError:`, err.errors);
    res.status(400).json({ error: "Validation error", details: err.errors, requestId });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  console.error(`[${requestId}] Unhandled error:`, rootError.message, rootError.stack);
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    requestId,
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });

  res.status(500).json({ error: "An unexpected error occurred", requestId });
}
