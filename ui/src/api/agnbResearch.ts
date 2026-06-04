import { ported, unwrap } from "./agnbClient";

export interface Competitor {
  id: string; name: string; domain: string; sitemap_url: string; status: string;
  last_scraped_at: string | null; last_error: string | null; total_blogs_seen: number | null; created_at: string;
}
export interface ContentGap {
  id: string; topic: string; gap_score: number; competitor_count: number; our_coverage_count: number;
  suggested_keywords: string[] | null; status: string; suggestion_type: string; created_at: string;
}
export interface BlogIdea {
  id: string; raw_text: string; source: string | null; status: string; related_topic: string | null; notes: string | null; created_by: string | null; created_at: string;
}
export interface RssFeed {
  id: string; name: string; url: string; category: string | null; status: string; last_synced_at: string | null; last_error: string | null; items_count: number | null;
}
export interface RssItem {
  id: string; feed_id: string; feed_name: string | null; title: string; url: string; summary: string | null; published_at: string | null; fetched_at: string;
}
export interface BofuPage {
  id: string; url: string; title: string; competitor: string | null; content_type: string; primary_keyword: string | null;
  status: string; current_rank: number | null; monthly_traffic: number | null; monthly_signups: number | null; last_checked_at: string | null; created_at: string;
}
export interface ContentBrief {
  id: string; title: string; content_type: string; stage: string; primary_keyword: string | null; buyer_phrase: string | null; target_url: string | null;
  published_at: string | null; refresh_due_at: string | null; created_at: string; created_by: string;
}

export const researchApi = {
  // Ported to All Gas No Brakes server — same-origin /api/agnb/*.
  competitors: () =>
    ported<{ ok: boolean; error?: string; competitors: Competitor[]; gaps: ContentGap[] }>("/competitors").then((r) => unwrap(r)),
  ideaInbox: () =>
    ported<{ ok: boolean; error?: string; ideas: BlogIdea[] }>("/idea-inbox").then((r) => unwrap(r).ideas),
  rssFeeds: () =>
    ported<{ ok: boolean; error?: string; feeds: RssFeed[]; items: RssItem[] }>("/rss-feeds").then((r) => unwrap(r)),
  bofu: () =>
    ported<{ ok: boolean; error?: string; pages: BofuPage[] }>("/bofu").then((r) => unwrap(r).pages),
  content: () =>
    ported<{ ok: boolean; error?: string; briefs: ContentBrief[] }>("/content").then((r) => unwrap(r).briefs),

  // --- competitors CRUD ---
  addCompetitor: (b: { name: string; domain: string; sitemap_url: string }) => ported("/competitors", { method: "POST", body: b }),
  patchCompetitor: (id: string, b: Record<string, unknown>) => ported(`/competitors?id=${id}`, { method: "PATCH", body: b }),
  deleteCompetitor: (id: string) => ported(`/competitors?id=${id}`, { method: "DELETE" }),
  // --- idea inbox ---
  captureIdea: (b: { raw_text: string; source?: string }) => ported("/idea-inbox", { method: "POST", body: b }),
  patchIdea: (id: string, b: { status?: string }) => ported(`/idea-inbox?id=${id}`, { method: "PATCH", body: b }),
  deleteIdea: (id: string) => ported(`/idea-inbox?id=${id}`, { method: "DELETE" }),
  // --- rss ---
  addFeed: (b: { name: string; url: string; category?: string }) => ported("/rss-feeds", { method: "POST", body: b }),
  deleteFeed: (id: string) => ported(`/rss-feeds?id=${id}`, { method: "DELETE" }),
  // --- bofu ---
  addBofu: (b: { url: string; title: string; content_type?: string; competitor?: string; primary_keyword?: string }) => ported("/bofu", { method: "POST", body: b }),
  deleteBofu: (id: string) => ported(`/bofu?id=${id}`, { method: "DELETE" }),
  // --- content briefs ---
  createBrief: (b: { title: string; content_type?: string; stage?: string; primary_keyword?: string }) => ported("/content", { method: "POST", body: b }),
  patchBrief: (id: string, b: { stage?: string }) => ported(`/content?id=${id}`, { method: "PATCH", body: b }),
  deleteBrief: (id: string) => ported(`/content?id=${id}`, { method: "DELETE" }),
};
