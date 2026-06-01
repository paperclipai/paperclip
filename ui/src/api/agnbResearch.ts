import { agnb, unwrap } from "./agnbClient";

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
  competitors: () =>
    agnb.get<{ ok: boolean; error?: string; competitors: Competitor[]; gaps: ContentGap[] }>("/competitors").then((r) => unwrap(r)),
  ideaInbox: () =>
    agnb.get<{ ok: boolean; error?: string; ideas: BlogIdea[] }>("/idea-inbox").then((r) => unwrap(r).ideas),
  rssFeeds: () =>
    agnb.get<{ ok: boolean; error?: string; feeds: RssFeed[]; items: RssItem[] }>("/rss-feeds").then((r) => unwrap(r)),
  bofu: () =>
    agnb.get<{ ok: boolean; error?: string; pages: BofuPage[] }>("/bofu").then((r) => unwrap(r).pages),
  content: () =>
    agnb.get<{ ok: boolean; error?: string; briefs: ContentBrief[] }>("/content").then((r) => unwrap(r).briefs),
};
