/**
 * Browser-safe URL key for matching markdown hrefs against the
 * `external_objects.sanitizedCanonicalUrl` returned by the host API.
 *
 * The shared/server canonicalizer is the source of truth for the canonical
 * URL string, but it imports from `node:crypto` (it also produces an identity
 * hash) and therefore cannot run in the browser. We replicate just the URL
 * normalization here:
 *
 *   - protocol must be http or https
 *   - reject userinfo (`username:password@`)
 *   - lowercase host
 *   - drop query string + fragment
 *   - default empty pathname to `/`
 */
export function normalizeExternalObjectHref(value: string | null | undefined): string | null {
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const scheme = url.protocol === "https:" ? "https" : "http";
  const path = url.pathname || "/";
  return `${scheme}://${url.host.toLowerCase()}${path}`;
}
