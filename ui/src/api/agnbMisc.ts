import { agnb, unwrap } from "./agnbClient";

export interface ApiToken {
  id: string; name: string; scopes: string[] | null; active: boolean; created_at: string; created_by: string;
  last_used_at: string | null; request_count: number; requests_per_minute: number | null;
}
export interface QuotaRow { method: string; used: number; cap: number; pct: number; avg7d: number }
export interface PerfRow { id: string; platform: string; url: string | null; impressions: number; views: number; reactions: number; comments: number; shares: number; ctr_pct: number | null; watch_time_sec: number | null; sampled_at: string }
export interface Recipe { id: string; name: string; trigger_event: string; trigger_filter: unknown; actions: unknown; active: boolean; created_at: string; last_fired_at: string | null; fire_count: number }
export interface ContentComment { id: string; platform: string; author: string | null; body: string; sentiment: string | null; is_question: boolean | null; replied: boolean; reply_draft: string | null; created_at: string | null; ingested_at: string }

export const miscApi = {
  tokens: () => agnb.get<{ ok: boolean; error?: string; tokens: ApiToken[] }>("/tokens").then((r) => unwrap(r).tokens),
  createToken: (b: { name: string; scopes: string[]; requests_per_minute?: number }) =>
    agnb.post<{ ok: boolean; error?: string; token?: string }>("/tokens", b).then((r) => unwrap(r)),
  deleteToken: (id: string) => agnb.delete(`/tokens?id=${id}`),

  quota: () => agnb.get<{ ok: boolean; error?: string; usage: QuotaRow[] }>("/quota").then((r) => unwrap(r).usage),
  contentPerformance: (days = 30) => agnb.get<{ ok: boolean; error?: string; rows: PerfRow[] }>(`/content-performance?days=${days}`).then((r) => unwrap(r).rows),

  workflows: () => agnb.get<{ ok: boolean; error?: string; recipes: Recipe[] }>("/workflow-recipes").then((r) => unwrap(r).recipes),
  toggleWorkflow: (id: string, active: boolean) => agnb.patch("/workflow-recipes", { id, active }),
  deleteWorkflow: (id: string) => agnb.delete(`/workflow-recipes?id=${id}`),

  comments: (filter?: string) => agnb.get<{ ok: boolean; error?: string; comments: ContentComment[] }>(`/comments${filter ? `?filter=${filter}` : ""}`).then((r) => unwrap(r).comments),
  markReplied: (id: string) => agnb.patch(`/comments?id=${id}&replied=1`, {}),
  draftReply: (id: string) => agnb.post(`/comments/draft-reply?id=${id}`, {}),
};
