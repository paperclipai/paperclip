import { agnb, unwrap } from "./agnbClient";

export interface TeamMember {
  id: string; name: string; email: string | null; role: string | null; is_ai: boolean; ai_engine: string | null;
  skills: string[] | null; teams: string[] | null; capacity_daily: number | null; weight: number | null; active: boolean;
  open_load?: number; done_7d?: number;
}
export interface WorkItem {
  id: string; kind: string; title: string | null; priority: number | null; sla_due_at: string | null;
  assigned_to: string | null; status: string; blocked_reason: string | null; completed_at: string | null; assigned_at: string | null; created_at: string;
  team_members?: { name: string; is_ai: boolean; email: string | null } | null;
}
export interface RoutingRule {
  id: string; kind: string; prefer_skills: string[] | null; strategy: string; fallback_member: string | null; weight: number | null; active: boolean; notes: string | null;
}

export const teamApi = {
  members: () => agnb.get<{ ok: boolean; error?: string; members: TeamMember[] }>("/team").then((r) => unwrap(r).members),
  ingest: () => agnb.post("/team/ingest", {}),
  autoRoute: () => agnb.post("/team/auto-route", {}),
  work: (query = "") => agnb.get<{ ok: boolean; error?: string; items: WorkItem[] }>(`/team/work${query}`).then((r) => unwrap(r).items),
  workAction: (id: string, action: string, body: Record<string, unknown> = {}) => agnb.patch(`/team/work?id=${id}&action=${action}`, body),
  rules: () => agnb.get<{ ok: boolean; error?: string; rules: RoutingRule[] }>("/team/rules").then((r) => unwrap(r).rules),
  patchRule: (id: string, body: Record<string, unknown>) => agnb.patch(`/team/rules?id=${id}`, body),
  deleteRule: (id: string) => agnb.delete(`/team/rules?id=${id}`),
};
