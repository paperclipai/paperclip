import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";

export interface ErrorContext {
  error: {
    message: string;
    stack?: string;
    name?: string;
    details?: unknown;
    raw?: unknown;
    pg?: PostgresErrorFields;
  };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

interface PostgresErrorFields {
  code?: string;
  constraint?: string;
  table?: string;
  schema?: string;
  column?: string;
  detail?: string;
  hint?: string;
  severity?: string;
  routine?: string;
  where?: string;
}

// Surface postgres-js error fields when present. The driver does not put the
// constraint name or table into err.message or err.stack, so they would be
// lost without explicit lifting. See GLA-291 for the failure mode this guards
// against (a 23505 with only postgres@3.4.8 driver frames in the stack).
function extractPostgresErrorFields(err: unknown): PostgresErrorFields | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code !== "string") return undefined;
  const out: PostgresErrorFields = { code: e.code };
  for (const key of [
    "constraint_name",
    "table_name",
    "schema_name",
    "column_name",
    "detail",
    "hint",
    "severity",
    "routine",
    "where",
  ] as const) {
    const v = e[key];
    if (typeof v === "string" && v.length > 0) {
      const outKey = key.replace(/_name$/, "") as keyof PostgresErrorFields;
      (out as Record<string, string>)[outKey] = v;
    }
  }
  return out;
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

  const rootError = err instanceof Error ? err : new Error(String(err));
  const pg = extractPostgresErrorFields(err);
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name, ...(pg ? { pg } : {}) }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name, ...(pg ? { pg } : {}) },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: pg?.code ?? rootError.name });

  res.status(500).json({ error: "Internal server error" });
}
