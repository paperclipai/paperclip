import type { RequestHandler } from "express";

/**
 * Appends `publicUrl` (the host's configured public origin) to every JSON
 * response that flows through the routes this middleware is attached to.
 *
 * Lives in middleware rather than inside `health.ts` so future merges of
 * `paperclipai/master` don't conflict on the route file. The plugin host
 * context plumbing (UI side) reads `body.publicUrl` from `/api/health` to
 * thread the public origin through to plugins; without it, the Linear
 * plugin's OAuth `redirect_uri` falls back to `window.location.origin`,
 * which can be a tailnet/LAN address and produce an unregistered
 * redirect_uri that Linear rejects. This regression has happened twice
 * across upstream merges, hence the extraction.
 *
 * The trailing-slash strip means callers can safely concatenate a
 * leading-slash path (`${publicUrl}/api/...`) without producing `//`.
 */
export function appendPublicUrl(publicUrl: string | null): RequestHandler {
  const normalized = publicUrl ? publicUrl.replace(/\/+$/, "") : null;
  return (_req, res, next) => {
    const origJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        !("publicUrl" in body)
      ) {
        return origJson({ ...(body as Record<string, unknown>), publicUrl: normalized });
      }
      return origJson(body);
    }) as typeof res.json;
    next();
  };
}
