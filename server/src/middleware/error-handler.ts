import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      (res as any).__errorContext = {
        error: { message: err.message, stack: err.stack, name: err.name, details: err.details },
        method: req.method,
        url: req.originalUrl,
        reqBody: req.body,
        reqParams: req.params,
        reqQuery: req.query,
      } satisfies ErrorContext;
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

  (res as any).__errorContext = {
    error: err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err },
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;

  res.status(500).json({ error: "Internal server error" });
}
