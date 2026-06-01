export type CcrotateTarget = "claude" | "codex";

export interface AccountRow {
  email: string;
  target: CcrotateTarget;
  tier: string;
  utilization5h: number | null;
  utilization7d: number | null;
  utilization7dSonnet: number | null;
  utilization7dOpus: number | null;
  availability: string;
  availabilityMark?: string | null;
  apiLimit: string | null;
  isActive: boolean;
  isHealthy: boolean;
  isStale?: boolean;
}

export interface SnapshotResponse {
  fetchedAt: string;
  cacheAge: string | null;
  targets: Record<CcrotateTarget, { error?: string; accounts?: AccountRow[] }>;
}

export interface PersistedSnapshot {
  blob: string;
  capturedAt: string;
}
