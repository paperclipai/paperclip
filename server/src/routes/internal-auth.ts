import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";

/**
 * Middleware that validates the x-internal-secret header against
 * PAPERCLIP_INTERNAL_API_SECRET using a constant-time comparison to prevent
 * timing attacks.
 *
 * Returns 401 if the header is missing or does not match.
 */
export function internalSecretAuth(req: Request, _res: Response, next: NextFunction) {
  const secret = process.env.PAPERCLIP_INTERNAL_API_SECRET;
  const provided = req.headers["x-internal-secret"];

  if (!secret) {
    // Misconfiguration: the internal API is unreachable until the operator
    // sets PAPERCLIP_INTERNAL_API_SECRET. Surface it loudly while still 401-ing.
    logger.error(
      "PAPERCLIP_INTERNAL_API_SECRET is not set; rejecting all internal API requests",
    );
    throw unauthorized("Missing or invalid x-internal-secret");
  }

  if (!provided || typeof provided !== "string") {
    throw unauthorized("Missing or invalid x-internal-secret");
  }

  // Use constant-time comparison to prevent timing attacks
  const secretBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);

  // Buffers must be same length for timingSafeEqual; mismatched length → reject
  if (secretBuf.length !== providedBuf.length) {
    throw unauthorized("Missing or invalid x-internal-secret");
  }

  if (!timingSafeEqual(secretBuf, providedBuf)) {
    throw unauthorized("Missing or invalid x-internal-secret");
  }

  next();
}
