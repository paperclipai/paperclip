import type { CouchHttp, CouchResponse } from "./couch-store.js";

/**
 * Minimal shape of the host ctx.http we rely on.
 * The real PluginHttpClient exposes fetch(url, init?: RequestInit): Promise<Response>.
 * Response has .status and .json() which is what we need.
 */
export interface CtxHttpLike {
  fetch(url: string, init?: RequestInit): Promise<{ status: number; json(): Promise<unknown> }>;
}

export function createCtxCouchHttp(
  http: CtxHttpLike,
  cfg: { baseUrl: string; user?: string; password?: string },
): CouchHttp {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const auth: Record<string, string> = cfg.user
    ? { Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password ?? ""}`).toString("base64")}` }
    : {};
  return {
    async request(method, path, body): Promise<CouchResponse> {
      const res = await http.fetch(`${base}${path}`, {
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
