import { agnb, unwrap } from "./agnbClient";

/**
 * Same-origin fetch for AGNB endpoints already ported into the Paperclip
 * server (under /api/agnb/*). As each route group migrates off the standalone
 * AGNB app, its client call moves here. See docs/migration/AGNB_CONSOLIDATION.md.
 */
async function ported<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/agnb${path}`, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `AGNB request failed: ${res.status}`);
  }
  return res.json();
}

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
  // Ported to Paperclip server — same-origin /api/agnb/team.
  members: () => ported<{ ok: boolean; error?: string; members: TeamMember[] }>("/team").then((r) => unwrap(r).members),
  // PHASE 5: ingest sweeps source tables (worker) — left cross-origin.
  ingest: () => agnb.post("/team/ingest", {}),
  // PHASE 5: auto-route runs the routing engine (worker) — left cross-origin.
  autoRoute: () => agnb.post("/team/auto-route", {}),
  // Ported to Paperclip server — same-origin /api/agnb/team/work.
  work: (query = "") => ported<{ ok: boolean; error?: string; items: WorkItem[] }>(`/team/work${query}`).then((r) => unwrap(r).items),
  // work?action=reassign with no assignee hits the routing engine (Phase 5) and
  // returns 501 same-origin; all other actions (claim|done|block|reopen|manual
  // reassign) are pure DB ops handled by the Paperclip server.
  workAction: (id: string, action: string, body: Record<string, unknown> = {}) =>
    ported(`/team/work?id=${id}&action=${action}`, { method: "PATCH", body }),
  // Ported to Paperclip server — same-origin /api/agnb/team/rules.
  rules: () => ported<{ ok: boolean; error?: string; rules: RoutingRule[] }>("/team/rules").then((r) => unwrap(r).rules),
  patchRule: (id: string, body: Record<string, unknown>) => ported(`/team/rules?id=${id}`, { method: "PATCH", body }),
  deleteRule: (id: string) => ported(`/team/rules?id=${id}`, { method: "DELETE" }),
};
