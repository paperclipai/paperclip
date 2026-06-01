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

export const linkedinQueueApi = {
  queue: () => agnb.get<{ ok: boolean; error?: string; rows: QueueRow[] }>("/linkedin-queue").then((r) => unwrap(r).rows),
  hooks: () => agnb.get<{ ok: boolean; error?: string; hooks: Hook[] }>("/linkedin-hooks").then((r) => unwrap(r).hooks),
  series: () => agnb.get<{ ok: boolean; error?: string; series: Series[] }>("/linkedin-series").then((r) => unwrap(r).series),
};
