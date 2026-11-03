import path from "node:path";

/**
 * Cache-Control override for non-hashed UI static files (everything outside
 * /assets, which is content-hashed and immutable). Two files must always be
 * revalidated:
 *
 * - `index.html` must never outlive the asset hashes it points at.
 * - `sw.js` is the browser's only channel for updating an installed service
 *   worker: clients re-fetch this exact URL to discover new worker code, so
 *   any cache TTL here delays every client's update by that long on top of
 *   the browser's own update timer.
 *
 * Returns undefined for files where the middleware's default TTL applies.
 */
export function staticUiCacheControl(filePath: string): "no-cache" | undefined {
  const basename = path.basename(filePath);
  return basename === "index.html" || basename === "sw.js" ? "no-cache" : undefined;
}
