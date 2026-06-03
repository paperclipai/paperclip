import { agnb, unwrap } from "./agnbClient";

/**
 * Same-origin fetch for AGNB endpoints already ported into the All Gas No Brakes
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

export interface YtIdea { id: string; title: string; source: string | null; source_url: string | null; est_views: number | null; score: number | null; status: string; notes: string | null; created_at: string }
export interface YtScript { id: string; title: string; status: string; duration_sec: number | null; hook_text: string | null; publish_at: string | null; published_url: string | null; views: number; watch_time_pct: number | null; ctr_pct: number | null; updated_at: string }
export interface YtTitle { id: string; script_id: string; title: string; is_winner: boolean; ctr_pct: number | null; votes: number | null; created_at: string }
export interface YtThumbnail { id: string; url: string; concept: string | null; is_winner: boolean; ctr_pct: number | null; created_at: string }
export interface YtShort { id: string; parent_script_id: string | null; title: string; hook_sec: number | null; duration_sec: number | null; caption: string | null; status: string; publish_at: string | null; views: number; cross_post_ig: boolean | null }
export interface YtPerf { id: string; platform: string; url: string | null; views: number; watch_time_sec: number | null; ctr_pct: number | null; sampled_at: string }

export interface YoutubeData {
  ideas: YtIdea[]; scripts: YtScript[]; titles: YtTitle[]; thumbnails: YtThumbnail[]; shorts: YtShort[]; performance: YtPerf[];
}

export interface Trend { title: string; source: string; angle: string; score: number; source_url?: string }

export const youtubeApi = {
  // Ported to All Gas No Brakes server — same-origin /api/agnb/youtube.
  all: () => ported<{ ok: boolean; error?: string } & YoutubeData>("/youtube").then((r) => {
    const u = unwrap(r);
    return { ideas: u.ideas, scripts: u.scripts, titles: u.titles, thumbnails: u.thumbnails, shorts: u.shorts, performance: u.performance } as YoutubeData;
  }),

  // --- ideas ---
  captureIdea: (title: string) => agnb.post("/youtube/ideas", { title }),
  patchIdea: (id: string, b: { status?: string }) => agnb.patch(`/youtube/ideas?id=${id}`, b),
  deleteIdea: (id: string) => agnb.delete(`/youtube/ideas?id=${id}`),
  // --- trends ---
  fetchTrends: () => agnb.post<{ ok: boolean; error?: string; trends: Trend[] }>("/youtube/trends", {}).then((r) => unwrap(r).trends),
  promoteTrend: (t: Trend) => agnb.post("/youtube/ideas", { title: t.title, source: t.source, source_url: t.source_url ?? null, score: t.score }),
  // --- scripts ---
  createScript: (title: string) => agnb.post("/youtube/scripts", { title }),
  patchScript: (id: string, b: { status?: string }) => agnb.patch(`/youtube/scripts?id=${id}`, b),
  deleteScript: (id: string) => agnb.delete(`/youtube/scripts?id=${id}`),
  // --- titles ---
  titleWinner: (id: string) => agnb.patch(`/youtube/titles?id=${id}`, { is_winner: true }),
  deleteTitle: (id: string) => agnb.delete(`/youtube/titles?id=${id}`),
  // --- thumbnails ---
  thumbWinner: (id: string) => agnb.patch(`/youtube/thumbnails?id=${id}`, { is_winner: true }),
  deleteThumb: (id: string) => agnb.delete(`/youtube/thumbnails?id=${id}`),
  // --- shorts ---
  addShort: (b: { title: string; parent_script_id?: string; duration_sec?: number }) => agnb.post("/youtube/shorts", b),
  patchShort: (id: string, b: { status?: string }) => agnb.patch(`/youtube/shorts?id=${id}`, b),
  deleteShort: (id: string) => agnb.delete(`/youtube/shorts?id=${id}`),
  millShorts: () => agnb.post("/youtube/mine", {}),
};
