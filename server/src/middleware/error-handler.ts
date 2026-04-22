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

  // postgres.js raises with err.code === 'P0403' for the status-transition guard.
  // Translate to 422 so clients receive an actionable error instead of an opaque 500.
  if (
    err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "P0403" &&
    typeof (err as { message?: unknown }).message === "string" &&
    ((err as { message: string }).message).startsWith("Status transition blocked:")
  ) {
    res.setHeader("Cache-Control", "no-store");
    res.status(422).json({
      error: "status_transition_blocked",
      message: (err as { message: string }).message,
      legalPaths: [
        "POST /functions/v1/policy-engine (preferred)",
        "PATCH with blockReason to block",
        "X-Admin-Override: <CEO-scoped JWT> for break-glass",
      ],
    });
    return;
  }

  // Replay guard for admin-override audit: unique violation on override_jwt_jti
  // (AKS-1597 §7.3) means the same CEO JWT was presented twice. Map to 422 so
  // the UI can surface "re-sign required" instead of a 500.
  if (
    err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "23505" &&
    typeof (err as { constraint_name?: unknown }).constraint_name === "string" &&
    (err as { constraint_name: string }).constraint_name.includes("override_jwt_jti")
  ) {
    res.setHeader("Cache-Control", "no-store");
    res.status(422).json({
      error: "admin_override_replay",
      message: "This admin override JWT has already been consumed. Re-sign a fresh token.",
    });
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
