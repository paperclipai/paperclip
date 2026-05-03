import type { RequestHandler } from "express";

/**
 * Middleware that detects JSON request bodies encoded as Latin-1 / CP-1252
 * (instead of UTF-8) and re-decodes them so downstream handlers see correct
 * Unicode characters.
 *
 * This fixes a common issue on Windows where Git-Bash's mingw64 curl silently
 * transcodes UTF-8 CLI arguments to the active OEM code page, corrupting
 * accented characters (Portuguese, Spanish, French, etc.).
 */
export function latin1BodyRepair(): RequestHandler {
  return (req, _res, next) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (
      rawBody &&
      req.is("application/json") &&
      req.body != null
    ) {
      // Check whether the raw bytes are valid UTF-8 by round-tripping.
      // If they are, nothing to repair.
      const utf8 = rawBody.toString("utf8");
      if (Buffer.from(utf8, "utf8").equals(rawBody)) {
        return next();
      }

      // Raw bytes are NOT valid UTF-8 — assume Latin-1 and re-parse.
      try {
        const repaired = rawBody.toString("latin1");
        req.body = JSON.parse(repaired);
      } catch {
        // If re-parsing fails, leave body as-is and let downstream handle it.
      }
    }
    next();
  };
}
