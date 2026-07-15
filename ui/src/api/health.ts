import type { ServerInfoSnapshot } from "@paperclipai/shared";

export type DevServerAdoptionReport = {
  completedAt: string;
  newServerVersion: string | null;
  adopted: number;
  finalizedWhileDown: number;
  lost: number;
};

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
  hotRestartEnabled: boolean;
  eligibleLiveRunCount: number;
  adoptionReport: DevServerAdoptionReport | null;
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
  requestDevServerRestart: async (opts?: { hot?: boolean }): Promise<void> => {
    const res = await fetch("/api/health/dev-server/restart", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ hot: opts?.hot === true }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to request restart (${res.status})`);
    }
  },
};
