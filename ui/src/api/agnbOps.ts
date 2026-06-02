import { agnb, unwrap } from "./agnbClient";

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

/** Sync jobs — label + the AGNB POST path (relative to /api/agnb). */
export const SYNC_JOBS: Array<{ key: string; label: string; path: string }> = [
  { key: "sync-all", label: "Sync Rocket mirror", path: "/rocket/sync-all" },
  { key: "sync-inbox", label: "Sync inbox", path: "/rocket/sync-inbox?max_campaigns=5&per=20" },
  { key: "drain", label: "Drain events", path: "/events/drain" },
  { key: "rematch", label: "Rematch attribution", path: "/attribution/rematch" },
  { key: "summary", label: "Regenerate digest", path: "/summary" },
  { key: "mentions", label: "Mentions sync", path: "/inbound/mentions/sync" },
  { key: "sov", label: "SoV (Gemini)", path: "/inbound/sov/run" },
  { key: "pipeline", label: "HubSpot pipeline", path: "/inbound/pipeline/sync" },
  { key: "demos", label: "Demos (Cal)", path: "/inbound/demos/sync" },
  { key: "funnel", label: "PostHog funnel", path: "/inbound/funnel/sync" },
  { key: "bofu", label: "BoFu positions", path: "/inbound/bofu/sync" },
  { key: "backlinks", label: "Backlinks", path: "/inbound/backlinks/sync" },
  { key: "reviews", label: "Reviews", path: "/inbound/reviews/sync" },
  { key: "alerts", label: "Alerts check", path: "/alerts/check" },
  { key: "retention", label: "Retention purge", path: "/maintenance/retention" },
  { key: "snapshot", label: "Snapshot buckets", path: "/maintenance/snapshot-buckets" },
];

export const opsApi = {
  health: () => agnb.get<{ ok: boolean; error?: string; checks: HealthCheck[] }>("/health").then((r) => unwrap(r).checks),
  syncStatus: () => agnb.get<{ ok: boolean; error?: string } & SyncStatus>("/sync").then((r) => { const u = unwrap(r); return { counts: u.counts, worker: u.worker } as SyncStatus; }),
  runJob: (path: string) => agnb.post(path, {}),
  events: () => agnb.get<{ ok: boolean; error?: string; events: EventRow[] }>("/events").then((r) => unwrap(r).events),
  audit: () => agnb.get<{ ok: boolean; error?: string; audit: AuditRow[] }>("/audit").then((r) => unwrap(r).audit),
  entityAudit: () => agnb.get<{ ok: boolean; error?: string; audit: EntityAuditRow[] }>("/entity-audit").then((r) => unwrap(r).audit),
  pending: () => agnb.get<{ ok: boolean; error?: string; pending: PendingAction[] }>("/pending-actions").then((r) => unwrap(r).pending),
  pendingDecision: (ids: string[], decision: "approved" | "rejected") => agnb.patch("/pending-actions", { ids, decision }),
  notifications: () => agnb.get<{ ok: boolean; error?: string; notifications: Notification[]; readIds: string[] }>("/notifications").then((r) => { const u = unwrap(r); return { notifications: u.notifications, readIds: u.readIds }; }),
  markNotifRead: (id: string) => agnb.patch(`/notifications?id=${id}`, {}),
  markAllNotifRead: () => agnb.patch("/notifications?all=1", {}),
};
