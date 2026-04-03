import type { RequestHandler } from "express";

/**
 * Check for null bytes (\0) in any string value within the request body.
 * PostgreSQL text columns reject 0x00 bytes with:
 *   "invalid byte sequence for encoding 'UTF8': 0x00"
 *
 * Per OWASP input validation guidance, we reject-and-fail (400) rather
 * than silently stripping, consistent with the existing verifyUtf8Body
 * middleware approach.
 */
function containsNullByte(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("\0");
  }
  if (Array.isArray(value)) {
    return value.some(containsNullByte);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsNullByte);
  }
  return false;
}

export const rejectNullBytes: RequestHandler = (req, res, next) => {
  if (req.body && typeof req.body === "object" && containsNullByte(req.body)) {
    res.status(400).json({ error: "Request body contains null bytes" });
    return;
  }
  next();
};
