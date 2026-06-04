import { ported, unwrap } from "./agnbClient";

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
  // Ported to All Gas No Brakes server (Phase 4) — same-origin /api/agnb/*.
  mentions: () => ported<{ ok: boolean; error?: string; mentions: Mention[] }>("/mentions").then((r) => unwrap(r).mentions),
  reviews: () => ported<{ ok: boolean; error?: string; platforms: ReviewPlatform[]; log: ReviewLog[] }>("/reviews").then((r) => unwrap(r)),
  sov: () => ported<{ ok: boolean; error?: string; prompts: SovPrompt[]; results: SovResult[] }>("/sov").then((r) => unwrap(r)),
  backlinks: () => ported<{ ok: boolean; error?: string; backlinks: Backlink[] }>("/backlinks").then((r) => unwrap(r).backlinks),
  prospects: () => ported<{ ok: boolean; error?: string; prospects: BacklinkProspect[] }>("/backlink-prospects").then((r) => unwrap(r).prospects),

  // SoV prompt management (same-origin). Results are ingested by the SoV Monitor agent.
  addPrompt: (b: { prompt: string; category?: string }) => ported("/sov", { method: "POST", body: b }),
  deletePrompt: (id: string) => ported(`/sov?id=${id}`, { method: "DELETE" }),

  // Review-platform tracking (same-origin). Stats + review entries are ingested by the Reviews Monitor agent.
  addReviewPlatform: (b: { platform: string; profile_url: string; category?: string }) => ported("/reviews/platforms", { method: "POST", body: b }),
  deleteReviewPlatform: (id: string) => ported(`/reviews/platforms?id=${id}`, { method: "DELETE" }),
};
