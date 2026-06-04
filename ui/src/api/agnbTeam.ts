import { ported, unwrap } from "./agnbClient";

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
  // Ported to All Gas No Brakes server — same-origin /api/agnb/team.
  members: () => ported<{ ok: boolean; error?: string; members: TeamMember[] }>("/team").then((r) => unwrap(r).members),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/team/work.
  work: (query = "") => ported<{ ok: boolean; error?: string; items: WorkItem[] }>(`/team/work${query}`).then((r) => unwrap(r).items),
  // claim|done|block|reopen|manual reassign — pure DB ops handled same-origin by
  // the All Gas No Brakes server.
  workAction: (id: string, action: string, body: Record<string, unknown> = {}) =>
    ported(`/team/work?id=${id}&action=${action}`, { method: "PATCH", body }),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/team/rules.
  rules: () => ported<{ ok: boolean; error?: string; rules: RoutingRule[] }>("/team/rules").then((r) => unwrap(r).rules),
  patchRule: (id: string, body: Record<string, unknown>) => ported(`/team/rules?id=${id}`, { method: "PATCH", body }),
  deleteRule: (id: string) => ported(`/team/rules?id=${id}`, { method: "DELETE" }),
};
