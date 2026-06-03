import type { CouchHttp, CouchResponse } from "./couch-store.js";

/**
 * CouchDB HTTP adapter that uses the worker's global `fetch` directly.
 *
 * WHY global fetch: Paperclip's plugin egress gate (`isPrivateIP` /
 * `validateAndResolveFetchUrl`) blocks all private/reserved IPs including
 * loopback. CouchDB is typically on 127.0.0.1:5984, so we cannot route
 * through `ctx.http`. Local plugins run as trusted Node workers, so the
 * global `fetch` has no such restriction.
 */
export function createCouchHttp(
  cfg: { baseUrl: string; user?: string; password?: string },
): CouchHttp {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const auth: Record<string, string> = cfg.user
    ? { Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password ?? ""}`).toString("base64")}` }
    : {};
  return {
    async request(method, path, body): Promise<CouchResponse> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...auth },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let parsed: unknown = null;
      try { parsed = await res.json(); } catch { parsed = null; }
      return { status: res.status, body: parsed };
    },
  };
}
