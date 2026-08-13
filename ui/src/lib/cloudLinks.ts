/**
 * Links out of a tenant instance and into the Paperclip Cloud app.
 *
 * The base always comes from the health `cloud` block (derived from
 * `PAPERCLIP_CLOUD_API_ORIGIN`) — the cloud domain is never hardcoded, because
 * aliases move and self-hosted instances have no cloud block at all. Only the
 * origin of that value is used; a control-plane path suffix is dropped, exactly
 * as the server-side portfolio proxy resolves it.
 *
 * These are always full top-level navigations, never in-app routes: the cloud
 * harness shadows GET `/stacks` and `/stacks/*` on tenant hosts, so an in-app
 * route under that prefix would be unreachable.
 */
export function cloudAppUrl(cloudBaseUrl: string | null | undefined, path: string): string | null {
  const base = cloudBaseUrl?.trim();
  if (!base) return null;
  try {
    const url = new URL(path, base);
    // The base is server-supplied, but a stray non-web scheme must never reach
    // `window.location.assign`.
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Entry-code handoff for another stack: cloud authenticates the user for that
 * stack and wakes it if it is asleep before redirecting to its tenant host.
 */
export function cloudStackEnterUrl(
  cloudBaseUrl: string | null | undefined,
  stackSlug: string | null | undefined,
): string | null {
  const slug = stackSlug?.trim();
  if (!slug) return null;
  return cloudAppUrl(cloudBaseUrl, `/stacks/${encodeURIComponent(slug)}/enter`);
}

/** Cloud's own create-a-stack flow, which replaces the in-app company wizard. */
export function cloudStackCreateUrl(cloudBaseUrl: string | null | undefined): string | null {
  return cloudAppUrl(cloudBaseUrl, "/stacks/new");
}
