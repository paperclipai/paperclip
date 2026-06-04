/**
 * Shared envelope helper for AGNB same-origin API responses.
 *
 * The standalone cross-origin AGNB app (www.allgasnobrakes.online) has been
 * decommissioned; all data now lives in Paperclip and is served same-origin
 * under /api/agnb/* (see the per-group `ported()` helpers in the api modules).
 * The old cross-origin `agnb` client was removed — only this envelope unwrap
 * remains, shared across the same-origin readers.
 */

/**
 * Same-origin fetch for AGNB endpoints served by the Paperclip server under
 * /api/agnb/*. Defaults to GET; pass `{ method, body }` for writes. A JSON body
 * sets the Content-Type and is stringified; a 204 resolves to undefined.
 */
export async function ported<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/agnb${path}`, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `AGNB request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Unwrap AGNB's { ok, ...payload } envelope or throw on { ok:false, error }. */
export function unwrap<T>(r: { ok: boolean; error?: string } & T): T {
  if (!r.ok) throw new Error(r.error ?? "AGNB error");
  return r;
}
