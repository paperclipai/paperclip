import { agnb, unwrap } from "./agnbClient";

/**
 * Same-origin fetch for AGNB endpoints already ported into the Paperclip
 * server (under /api/agnb/*). As each route group migrates off the standalone
 * AGNB app, its client call moves here. See docs/migration/AGNB_CONSOLIDATION.md.
 */
async function ported<T>(path: string): Promise<T> {
  const res = await fetch(`/api/agnb${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `AGNB request failed: ${res.status}`);
  }
  return res.json();
}

export interface Mention {
  id: string; source: string; url: string; context: string | null; sentiment: string | null; author: string | null; has_link: boolean; noticed_at: string;
}
export interface ReviewPlatform {
  id: string; platform: string; profile_url: string; category: string | null; rating: number | null; review_count: number | null; ranked_position: number | null; last_checked_at: string;
}
export interface ReviewLog {
  id: string; platform: string; reviewer_handle: string | null; rating: number | null; excerpt: string | null; review_url: string | null; collected_at: string;
}
export interface SovPrompt { id: string; prompt: string; category: string | null }
export interface SovResult {
  id: string; prompt_id: string; engine: string; ran_at: string; brand_mentioned: boolean; position: number | null; competitors_mentioned: string[] | null;
}
export interface Backlink {
  id: string; source_url: string; source_domain: string; source_da: number | null; target_url: string; anchor_text: string | null; kind: string;
  acquired_at: string; reciprocal: boolean; status: string;
}
export interface BacklinkProspect {
  id: string; source_domain: string; source_url: string | null; referring_to: string | null; competitor_name: string | null; domain_rank: number | null;
  discovered_via: string; status: string; outreach_subject: string | null; outreach_sent_at: string | null; notes: string | null; discovered_at: string;
}

export const mentionsApi = {
  // Ported to Paperclip server (Phase 4) — same-origin /api/agnb/*.
  mentions: () => ported<{ ok: boolean; error?: string; mentions: Mention[] }>("/mentions").then((r) => unwrap(r).mentions),
  reviews: () => ported<{ ok: boolean; error?: string; platforms: ReviewPlatform[]; log: ReviewLog[] }>("/reviews").then((r) => unwrap(r)),
  sov: () => ported<{ ok: boolean; error?: string; prompts: SovPrompt[]; results: SovResult[] }>("/sov").then((r) => unwrap(r)),
  backlinks: () => ported<{ ok: boolean; error?: string; backlinks: Backlink[] }>("/backlinks").then((r) => unwrap(r).backlinks),
  prospects: () => ported<{ ok: boolean; error?: string; prospects: BacklinkProspect[] }>("/backlink-prospects").then((r) => unwrap(r).prospects),

  // --- writes (stay cross-origin → standalone AGNB app, PHASE 5) ---
  syncMentions: () => agnb.post("/inbound/mentions/sync", {}),
  logReview: (b: { platform: string; rating?: string; reviewer_handle?: string; excerpt?: string; review_url?: string }) => agnb.post("/reviews", b),
  addPrompt: (b: { prompt: string; category?: string }) => agnb.post("/sov", b),
  deletePrompt: (id: string) => agnb.delete(`/sov?id=${id}`),
  runSov: () => agnb.post("/inbound/sov/run", {}),
  addBacklink: (b: { source_url: string; target_url: string; source_domain?: string; anchor_text?: string; kind?: string; source_da?: string }) => agnb.post("/backlinks", b),
  deleteBacklink: (id: string) => agnb.delete(`/backlinks?id=${id}`),
  prospectStatus: (id: string, status: string) => agnb.post(`/backlinks/prospect-status/${id}`, { status }),
  draftOutreach: (id: string) => agnb.post(`/backlinks/draft-outreach/${id}`, {}),
};
