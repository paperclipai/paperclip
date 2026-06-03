/**
 * JustDial sidecar client — ported from agnb lib/agnb/justdial-sidecar.ts.
 *
 * Wraps the FastAPI shim on the Mac mini. Pure `fetch` — no Next/supabase deps.
 * Sidecar runs at JUSTDIAL_SIDECAR_URL (default http://127.0.0.1:8787).
 * Auth via shared bearer token JUSTDIAL_SIDECAR_TOKEN.
 *
 * Sidecar returns `blocked: true` when Cloudflare/JD challenges the request —
 * callers should back off + retry later instead of hammering.
 */

const BASE = process.env.JUSTDIAL_SIDECAR_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.JUSTDIAL_SIDECAR_TOKEN ?? "";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`;
  return h;
}

export type JdPhoneSource = "listing" | "whatsapp" | "tel" | "callcontent" | null;

export interface JdListing {
  name: string;
  url: string;
  address?: string | null;
  phone?: string | null; // sidecar v0.2: listing page has plaintext phone
  phone_source?: JdPhoneSource;
  rating?: number | null;
}

export interface JdSearchResp {
  listings: JdListing[];
  pages_scraped: number;
  blocked: boolean;
}

export async function jdSearch(opts: {
  category: string;
  city: string;
  page?: number;
  maxPages?: number;
}): Promise<JdSearchResp> {
  const r = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      category: opts.category,
      city: opts.city,
      page: opts.page ?? 1,
      max_pages: opts.maxPages ?? 1,
    }),
  });
  if (!r.ok) throw new Error(`sidecar /search ${r.status}`);
  return r.json() as Promise<JdSearchResp>;
}

export interface JdDetail {
  name?: string | null;
  phone?: string | null;
  phone_source?: "whatsapp" | "tel" | null;
  address?: string | null;
  website?: string | null;
  email?: string | null;
  rating?: number | null;
  review_count?: number | null;
  blocked: boolean;
}

export async function jdDetail(url: string): Promise<JdDetail> {
  const r = await fetch(`${BASE}/detail`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url }),
  });
  if (!r.ok) throw new Error(`sidecar /detail ${r.status}`);
  return r.json() as Promise<JdDetail>;
}

export async function jdHealth(): Promise<{ ok: boolean }> {
  try {
    const r = await fetch(`${BASE}/health`);
    return { ok: r.ok };
  } catch {
    return { ok: false };
  }
}
