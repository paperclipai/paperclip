import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

// Postgres invalid_text_representation — typically a non-UUID string handed to a uuid
// column. Surface as a structured 400 so callers get actionable feedback instead of
// a silent 500. See ROCAA-33.
function postgresInvalidTextRepresentation(err: unknown):
  | { message: string; where: string | null }
  | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; code?: unknown; message?: unknown; where?: unknown };
  if (e.name !== "PostgresError") return null;
  if (e.code !== "22P02") return null;
  const message = typeof e.message === "string" ? e.message : "Invalid input";
  const where = typeof e.where === "string" ? e.where : null;
  return { message, where };
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

  const pgInvalidText = postgresInvalidTextRepresentation(err);
  if (pgInvalidText) {
    res.status(400).json({
      error: "bad_uuid_input",
      details: { message: pgInvalidText.message, where: pgInvalidText.where },
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

  res.status(500).json({
    error: "Internal server error",
    ...(shouldExposeTrustedCloudTenantImportError(req) ? { message: rootError.message } : {}),
  });
}

function shouldExposeTrustedCloudTenantImportError(req: Request) {
  return req.actor?.source === "cloud_tenant"
    && req.method === "POST"
    && req.originalUrl.split("?")[0] === COMPANY_IMPORT_API_PATH;
}
