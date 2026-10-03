import type { Request } from "express";

/**
 * Detect requests whose URL refers to the API even though the canonical
 * "/api" router mount did not match them.
 *
 * These arrive when the client sends a malformed path:
 * - leading duplicate slashes:        "//api/health"
 * - an encoded slash in the path:     "/%2Fapi/health", "/api%2Fhealth"
 * - duplicated slashes mid-path:      "/api//health" (mount matches "/api",
 *   but the sub-router sees "/health" — covered by the API 404 middleware)
 *
 * The "/api" mount is exact-prefix routing on the raw path, so a malformed
 * variant skips every API route AND the JSON 404 middleware and falls through
 * to the SPA fallback, which served index.html with HTTP 200. API clients that
 * concatenate base URLs (baseUrl ending in "/" + "/api/x") hit this
 * intermittently depending on how the base URL was assembled. See the
 * API path guard contract test for the covered shapes.
 *
 * The comparison decodes percent-escapes once, collapses runs of slashes,
 * and strips leading slashes, so every malformed spelling of an API path
 * normalizes to its canonical form. Matching is case-sensitive: Express
 * routing is case-sensitive, "/API/..." is a browser-facing path, not an
 * API path.
 *
 * Query strings and hash fragments are ignored: an API path inside a query
 * value ("/issues?redirect=/api/x") is not an API request.
 */
export function isMalformedApiPath(originalUrl: string | undefined): boolean {
  if (!originalUrl) return false;
  const rawPath = originalUrl.split(/[?#]/, 1)[0] ?? "";
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // Malformed escape sequences: compare the raw bytes, same as Express does.
  }
  const normalized = "/" + decoded.replace(/\/{2,}/g, "/").replace(/^\/+/, "");
  return normalized === "/api" || normalized.startsWith("/api/");
}

export function isApiRequest(req: Request): boolean {
  return req.path === "/api" || req.path.startsWith("/api/") || isMalformedApiPath(req.originalUrl);
}
