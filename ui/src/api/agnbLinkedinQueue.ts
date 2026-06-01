import { agnb, unwrap } from "./agnbClient";

export interface QueueRow {
  id: string; source_type: string | null; content: string; scheduled_at: string | null; posted_at: string | null;
  linkedin_post_url: string | null; status: string; x_variant: string | null; series_id: string | null; episode_num: number | null;
  impressions: number | null; reactions: number | null; comments_count: number | null; worked_why: string | null;
  error_message: string | null; created_by: string | null; created_at: string; updated_at: string;
}
export interface Hook { id: string; hook: string; angle: string; uses: number; notes: string | null; created_at: string }
export interface Series {
  id: string; title: string; description: string | null; episodes: number; status: string; created_at: string; total: number; posted: number;
}

export interface ExtractedPost { hook: string; body: string; cta: string; x_variant?: string }

export const linkedinQueueApi = {
  queue: () => agnb.get<{ ok: boolean; error?: string; rows: QueueRow[] }>("/linkedin-queue").then((r) => unwrap(r).rows),
  hooks: () => agnb.get<{ ok: boolean; error?: string; hooks: Hook[] }>("/linkedin-hooks").then((r) => unwrap(r).hooks),
  series: () => agnb.get<{ ok: boolean; error?: string; series: Series[] }>("/linkedin-series").then((r) => unwrap(r).series),

  // --- writes (existing /linkedin/* endpoints) ---
  addPost: (b: { content: string; scheduled_at?: string; source_type?: string; source_id?: string }) => agnb.post("/linkedin/queue", b),
  patchPost: (id: string, b: { status?: string; scheduled_at?: string | null; content?: string }) => agnb.patch(`/linkedin/queue?id=${id}`, b),
  deletePost: (id: string) => agnb.delete(`/linkedin/queue?id=${id}`),
  addHook: (b: { hook: string; angle: string; notes?: string }) => agnb.post("/linkedin/hooks", b),
  deleteHook: (id: string) => agnb.delete(`/linkedin/hooks?id=${id}`),
  createSeries: (b: { title: string; description?: string }) => agnb.post("/linkedin/series", b),
  deleteSeries: (id: string) => agnb.delete(`/linkedin/series?id=${id}`),
  extract: (blogId: string) => agnb.post<{ ok: boolean; error?: string; posts: ExtractedPost[] }>(`/linkedin/extract?blog_id=${blogId}`, {}).then((r) => unwrap(r).posts),
};
