import { ported, unwrap } from "./agnbClient";

export interface HealthCheck { name: string; status: "ok" | "degraded" | "down" | "unknown"; detail: string }
export interface SyncStatus {
  counts: { lastSyncMin: number | null; lastSyncOk: boolean | null; inbox: number; unprocessed: number; unmatched: number };
  worker: { worker_id: string; beat_at: string; jobs: Array<{ key: string; lastRun?: number; lastOk?: string | null; lastError?: string | null }> } | null;
}
export interface EventRow { id: number; event_type: string; payload: unknown; bucket_id: string | null; source: string | null; created_at: string; processed_at: string | null; processor_error: string | null }
export interface AuditRow { id: string; method: string; ok: boolean; error: string | null; duration_ms: number; caller: string | null; called_at: string }
export interface EntityAuditRow { id: number; entity_type: string; entity_id: string; action: string; diff: unknown; actor_email: string | null; created_at: string }
export interface PendingAction { id: string; action_type: string; payload: { lead_name?: string; lead_email?: string; reason?: string }; bucket_id: string | null; proposed_by: string; proposed_at: string }
export interface Notification { id: string; kind: string; severity: string; title: string; body: string | null; link: string | null; created_at: string; pushed_channels: string[] }

export interface JobStatus {
  key: string;
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastResult: ({ ok: boolean; summary?: string } & Record<string, unknown>) | { ok: false; error: string } | null;
  missingEnv: string[];
}

export interface NorthStar {
  pipeline: { open_deals: number; open_value_usd: number };
  sov: { mention_rate: number | null; runs: number };
  reviews: { avg_rating: number | null; total_reviews: number; platforms: number };
  mentions: { total_30d: number; positive: number; negative: number };
  backlinks: { earned: number; prospects: number };
  content: { open_gaps: number; idea_inbox: number };
}

export const opsApi = {
  // Ported to All Gas No Brakes server (group: ops) — same-origin /api/agnb/health.
  health: () => ported<{ ok: boolean; error?: string; checks: HealthCheck[] }>("/health").then((r) => unwrap(r).checks),
  // Scheduler job health (instance-admin).
  jobs: () =>
    ported<{ ok: boolean; error?: string; enabled: boolean; jobs: JobStatus[] }>("/jobs").then((r) => {
      const u = unwrap(r);
      return { enabled: u.enabled, jobs: u.jobs };
    }),
  // Exec north-star KPIs.
  northStar: () => ported<{ ok: boolean; error?: string } & NorthStar>("/north-star").then((r) => unwrap(r)),
  // Ported to All Gas No Brakes server (group: ops) — same-origin /api/agnb/sync.
  syncStatus: () => ported<{ ok: boolean; error?: string } & SyncStatus>("/sync").then((r) => { const u = unwrap(r); return { counts: u.counts, worker: u.worker } as SyncStatus; }),
  // Ported to All Gas No Brakes server (Phase 4 group: ops) — same-origin /api/agnb/*.
  events: () => ported<{ ok: boolean; error?: string; events: EventRow[] }>("/events").then((r) => unwrap(r).events),
  audit: () => ported<{ ok: boolean; error?: string; audit: AuditRow[] }>("/audit").then((r) => unwrap(r).audit),
  entityAudit: () => ported<{ ok: boolean; error?: string; audit: EntityAuditRow[] }>("/entity-audit").then((r) => unwrap(r).audit),
  pending: () => ported<{ ok: boolean; error?: string; pending: PendingAction[] }>("/pending-actions").then((r) => unwrap(r).pending),
  notifications: () => ported<{ ok: boolean; error?: string; notifications: Notification[]; readIds: string[] }>("/notifications").then((r) => { const u = unwrap(r); return { notifications: u.notifications, readIds: u.readIds }; }),
};
