/**
 * Client for AGNB's cross-origin JSON API (the All-Gas-No-Brakes domain app).
 *
 * AGNB is served from a sibling subdomain (www.allgasnobrakes.online); the
 * `agnb_session` cookie is scoped to `.allgasnobrakes.online`, so a browser
 * fetch with credentials:"include" carries it. AGNB must allow this origin via
 * CORS (Access-Control-Allow-Origin + Allow-Credentials) — see lib/agnb/cors.ts
 * on the AGNB side.
 *
 * Base URL is configurable via VITE_AGNB_BASE_URL (defaults to prod).
 */
const AGNB_BASE = (
  (import.meta.env.VITE_AGNB_BASE_URL as string | undefined) ??
  "https://www.allgasnobrakes.online"
).replace(/\/$/, "");

const PREFIX = "/all-gas-no-brakes/api/agnb";

export class AgnbApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "AgnbApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${AGNB_BASE}${PREFIX}${path}`, {
    headers,
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new AgnbApiError(
      (errorBody as { error?: string } | null)?.error ??
        `AGNB request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const agnb = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/** Unwrap AGNB's { ok, ...payload } envelope or throw on { ok:false, error }. */
export function unwrap<T>(r: { ok: boolean; error?: string } & T): T {
  if (!r.ok) throw new AgnbApiError(r.error ?? "AGNB error", 0, r);
  return r;
}
