import { ported, unwrap } from "./agnbClient";

export interface YtIdea { id: string; title: string; source: string | null; source_url: string | null; est_views: number | null; score: number | null; status: string; notes: string | null; created_at: string }
export interface YtScript { id: string; title: string; status: string; duration_sec: number | null; hook_text: string | null; publish_at: string | null; published_url: string | null; views: number; watch_time_pct: number | null; ctr_pct: number | null; updated_at: string }
export interface YtTitle { id: string; script_id: string; title: string; is_winner: boolean; ctr_pct: number | null; votes: number | null; created_at: string }
export interface YtThumbnail { id: string; url: string; concept: string | null; is_winner: boolean; ctr_pct: number | null; created_at: string }
export interface YtShort { id: string; parent_script_id: string | null; title: string; hook_sec: number | null; duration_sec: number | null; caption: string | null; status: string; publish_at: string | null; views: number; cross_post_ig: boolean | null }
export interface YtPerf { id: string; platform: string; url: string | null; views: number; watch_time_sec: number | null; ctr_pct: number | null; sampled_at: string }

export interface YoutubeData {
  ideas: YtIdea[]; scripts: YtScript[]; titles: YtTitle[]; thumbnails: YtThumbnail[]; shorts: YtShort[]; performance: YtPerf[];
}

export const youtubeApi = {
  // Ported to All Gas No Brakes server — same-origin /api/agnb/youtube.
  all: () => ported<{ ok: boolean; error?: string } & YoutubeData>("/youtube").then((r) => {
    const u = unwrap(r);
    return { ideas: u.ideas, scripts: u.scripts, titles: u.titles, thumbnails: u.thumbnails, shorts: u.shorts, performance: u.performance } as YoutubeData;
  }),
};
