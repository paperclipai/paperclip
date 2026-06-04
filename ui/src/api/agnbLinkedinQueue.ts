import { ported, unwrap } from "./agnbClient";

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

export const linkedinQueueApi = {
  // Ported to All Gas No Brakes server — same-origin /api/agnb/linkedin-{queue,hooks,series}.
  queue: () => ported<{ ok: boolean; error?: string; rows: QueueRow[] }>("/linkedin-queue").then((r) => unwrap(r).rows),
  hooks: () => ported<{ ok: boolean; error?: string; hooks: Hook[] }>("/linkedin-hooks").then((r) => unwrap(r).hooks),
  series: () => ported<{ ok: boolean; error?: string; series: Series[] }>("/linkedin-series").then((r) => unwrap(r).series),

  // --- writes (ported /linkedin/{queue,hooks,series} CRUD) ---
  addPost: (b: { content: string; scheduled_at?: string; source_type?: string; source_id?: string }) =>
    ported("/linkedin/queue", { method: "POST", body: b }),
  patchPost: (id: string, b: { status?: string; scheduled_at?: string | null; content?: string }) =>
    ported(`/linkedin/queue?id=${id}`, { method: "PATCH", body: b }),
  deletePost: (id: string) => ported(`/linkedin/queue?id=${id}`, { method: "DELETE" }),
  addHook: (b: { hook: string; angle: string; notes?: string }) =>
    ported("/linkedin/hooks", { method: "POST", body: b }),
  deleteHook: (id: string) => ported(`/linkedin/hooks?id=${id}`, { method: "DELETE" }),
  createSeries: (b: { title: string; description?: string }) =>
    ported("/linkedin/series", { method: "POST", body: b }),
  deleteSeries: (id: string) => ported(`/linkedin/series?id=${id}`, { method: "DELETE" }),
};
