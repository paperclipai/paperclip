import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "./logger.js";
import { HttpError } from "../errors.js";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      (res as any).err = err;
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

  const errObj = err instanceof Error
    ? { message: err.message, stack: err.stack, name: err.name }
    : { raw: err };

  // Attach the real error so pino-http uses it instead of its generic
  // "failed with status code 500" message in the response-complete log
  const realError = err instanceof Error ? err : Object.assign(new Error(String(err)), { raw: err });
  (res as any).err = realError;

  logger.error(
    { err: errObj, method: req.method, url: req.originalUrl },
    "Unhandled error: %s %s — %s",
    req.method,
    req.originalUrl,
    err instanceof Error ? err.message : String(err),
  );
  res.status(500).json({ error: "Internal server error" });
}
