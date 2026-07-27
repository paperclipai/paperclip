import type { ServerInfoSnapshot } from "@paperclipai/shared";

export type DevServerHealthStatus = {
  enabled: true;
  restartRequired: boolean;
  reason: "backend_changes" | "pending_migrations" | "backend_changes_and_pending_migrations" | null;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  pendingMigrations: string[];
  autoRestartEnabled: boolean;
  activeRunCount: number;
  waitingForIdle: boolean;
  lastRestartAt: string | null;
};

export type HealthWarning = { code: string; message: string };

export type DatabaseBackupHealth = {
  enabled: boolean;
  status: "ok" | "warning";
  backupDir?: string;
  maxAgeHours?: number;
  latestBackup?: { name: string; path?: string; mtime: string; ageHours: number; sizeBytes: number } | null;
  lastFailure?: { path?: string; mtime: string; message: string } | null;
  warnings: HealthWarning[];
};

export type StateSnapshotHealth = {
  enabled: boolean;
  status: "ok" | "warning";
  markerDir?: string;
  latestSnapshot?: Record<string, unknown> | null;
  warnings: HealthWarning[];
};

export type HealthStatus = {
  status: "ok";
  version?: string;
  deploymentMode?: "local_trusted" | "authenticated";
  deploymentExposure?: "private" | "public";
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  bootstrapInviteActive?: boolean;
  features?: {
    companyDeletionEnabled?: boolean;
  };
  serverInfo?: ServerInfoSnapshot;
  devServer?: DevServerHealthStatus;
  databaseBackup?: DatabaseBackupHealth;
  stateSnapshot?: StateSnapshotHealth;
  warnings?: HealthWarning[];
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const res = await fetch("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to load health (${res.status})`);
    }
    return res.json();
  },
  requestDevServerRestart: async (): Promise<void> => {
    const res = await fetch("/api/health/dev-server/restart", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to request restart (${res.status})`);
    }
  },
};
