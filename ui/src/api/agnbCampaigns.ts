import { agnb, unwrap } from "./agnbClient";

/**
 * Same-origin fetch for AGNB endpoints already ported into the All Gas No Brakes
 * server (under /api/agnb/*). As each route group migrates off the standalone
 * AGNB app, its client call moves here. See docs/migration/AGNB_CONSOLIDATION.md.
 */
async function ported<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
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
  return res.json();
}

export interface Campaign {
  id: string;
  name: string | null;
  status: string | null;
  type: string | null;
  framework: string | null;
  sent_count: number | null;
  open_count: number | null;
  reply_count: number | null;
  meeting_count: number | null;
  open_rate: number | null;
  reply_rate: number | null;
  meeting_rate: number | null;
}
export interface Sender { id: string; email: string; sender_type: string | null; status: string | null }

export interface SavedTargeting {
  id: string;
  name: string;
  query: string;
  notes: string | null;
  tags: string[] | null;
  last_run_at: string | null;
  last_lead_count: number | null;
  created_at: string;
  created_by: string;
}

export interface Persona { id: string; name: string; title: string | null }
export interface Product { id: string; name: string; description: string | null }

export interface JustdialJob {
  id: string;
  category: string;
  city: string;
  max_pages: number;
  status: string;
  error: string | null;
  pages_scraped: number | null;
  leads_count: number | null;
  created_at: string;
  finished_at: string | null;
}

export interface LinkedinProfile {
  id: string;
  source_url: string;
  full_name: string | null;
  headline: string | null;
  location: string | null;
  current_company: string | null;
  current_title: string | null;
  photo_url: string | null;
  scraped_at: string | null;
  added_at: string;
}

export interface BucketRow {
  id: string;
  name: string;
  icp_id: string | null;
  icp_name: string | null;
  status: string;
  target_reply_rate: number | null;
  estimated_leads: number | null;
  created_at: string;
  rollup: {
    total_sent: number;
    total_replies: number;
    total_positive: number;
    total_meetings: number;
    compound_reply_rate: number | null;
    compound_positive_rate: number | null;
    campaigns_run: number;
  } | null;
}

export interface IcpRow {
  id: string;
  name: string;
  industries: string[] | null;
  company_size_min: number | null;
  company_size_max: number | null;
  regions: string[] | null;
  functions: string[] | null;
  seniority: string[] | null;
  tier: "now" | "later" | "monitor" | string;
  created_at: string;
}

export const campaignsApi = {
  // Ported to All Gas No Brakes server (Phase 4 group 1) — same-origin /api/agnb/campaigns.
  campaigns: () =>
    ported<{ ok: boolean; error?: string; campaigns: Campaign[]; senders: Sender[] }>("/campaigns").then((r) => unwrap(r)),
  // Ported to All Gas No Brakes server (Phase 4 group: catalog) — same-origin /api/agnb/*.
  targeting: () =>
    ported<{ ok: boolean; error?: string; targetings: SavedTargeting[] }>("/targeting").then((r) => unwrap(r).targetings),
  personas: () =>
    ported<{ ok: boolean; error?: string; personas: Persona[] }>("/studio/personas").then((r) => unwrap(r).personas),
  products: () =>
    ported<{ ok: boolean; error?: string; products: Product[] }>("/studio/products").then((r) => unwrap(r).products),
  justdial: () =>
    ported<{ ok: boolean; error?: string; jobs: JustdialJob[] }>("/leads/justdial").then((r) => unwrap(r).jobs),
  linkedin: () =>
    ported<{ ok: boolean; error?: string; profiles: LinkedinProfile[] }>("/linkedin").then((r) => unwrap(r).profiles),
  buckets: () =>
    ported<{ ok: boolean; error?: string; buckets: BucketRow[] }>("/buckets").then((r) => unwrap(r).buckets),
  icps: () =>
    ported<{ ok: boolean; error?: string; icps: IcpRow[] }>("/icps").then((r) => unwrap(r).icps),

  // --- write actions ---
  // Ported to All Gas No Brakes server (catalog group) — pure-DB inserts, same-origin /api/agnb/*.
  createIcp: (body: { name: string; tier: string; industries: string[]; regions: string[]; functions: string[]; company_size_min?: number | null; company_size_max?: number | null }) =>
    ported<{ ok: boolean; error?: string; id?: string }>("/icps", { method: "POST", body }).then((r) => unwrap(r)),
  saveTargeting: (body: { name: string; query: string; notes?: string; tags?: string[] }) =>
    ported<{ ok: boolean; error?: string; id?: string }>("/targeting", { method: "POST", body }).then((r) => unwrap(r)),
  createBucket: (body: { name: string; icp_id?: string | null; target_reply_rate?: number }) =>
    ported<{ ok: boolean; error?: string; id?: string }>("/buckets", { method: "POST", body }).then((r) => unwrap(r)),

  // --- left cross-origin (external Rocket SDR / scraper sidecars, not pure DB) → Phase 5 ---
  createPersona: (body: { name: string; title?: string; description?: string }) =>
    agnb.post<{ ok: boolean; error?: string }>("/rocket/personas/create", body).then((r) => unwrap(r)),
  createProduct: (body: { name: string; description?: string }) =>
    agnb.post<{ ok: boolean; error?: string }>("/rocket/products/create", body).then((r) => unwrap(r)),
  // Ported to All Gas No Brakes server (catalog group) — same-origin sidecar-backed writes.
  queueJustdial: (body: { category: string; city: string; max_pages: number }) =>
    ported<{ ok: boolean; error?: string }>("/leads/justdial", { method: "POST", body }).then((r) => unwrap(r)),
  runJustdial: (id: string) =>
    ported<{ ok: boolean; error?: string }>(`/leads/justdial/run?id=${encodeURIComponent(id)}`, { method: "POST" }),
  scrapeLinkedin: (url: string) =>
    ported<{ ok: boolean; error?: string }>("/linkedin/scrape", { method: "POST", body: { url } }).then((r) => unwrap(r)),
  syncLinkedin: () =>
    ported<{ ok: boolean; error?: string }>("/linkedin/sync", { method: "POST" }),
};
