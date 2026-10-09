import type { ServerInfoSnapshot } from "@paperclipai/shared";
import { tenantSessionRecovery } from "@/lib/tenant-session-recovery";
import { ApiError } from "./client";
import { ApiUnavailableError, readApiJson } from "./response";

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

export type CloudInstanceHealthStatus = {
  managed: true;
  managedBy: "paperclip-cloud";
  stackSlug: string | null;
  stackDisplayName?: string;
  cloudBaseUrl: string | null;
};

export type HealthStatus = {
  status: "ok" | "starting";
  version?: string;
  /** Commit of the running server; null when build metadata is unavailable. */
  commit?: string | null;
  deploymentMode?: "local_trusted" | "authenticated";
  deploymentExposure?: "private" | "public";
  localAiLoginSupported?: boolean;
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  bootstrapInviteActive?: boolean;
  /** The unclaimed Cloud app is ready; this response did not probe SQL. */
  warmStandby?: boolean;
  features?: {
    companyDeletionEnabled?: boolean;
  };
  serverInfo?: ServerInfoSnapshot;
  devServer?: DevServerHealthStatus;
  cloud?: CloudInstanceHealthStatus;
  /**
   * Settings surfaces hidden by the hosting operator (keys from the shared
   * settings-visibility registry). Absent when nothing is hidden.
   */
  hiddenSettings?: string[];
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const res = await fetch("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const payload = await readApiJson<HealthStatus & { error?: string } | null>(res);
    if (!res.ok) {
      const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
      if (recovery) return recovery;
      throw new ApiError(payload?.error ?? `Failed to load health (${res.status})`, res.status, payload);
    }
    // Startup recovery can still serve sign-in and deployment metadata.
    if (payload?.status !== "ok" && payload?.status !== "starting") throw new ApiUnavailableError(res.status);
    return payload;
  },
  requestDevServerRestart: async (): Promise<void> => {
    const res = await fetch("/api/health/dev-server/restart", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
      if (recovery) return recovery;
      throw new Error(payload?.error ?? `Failed to request restart (${res.status})`);
    }
  },
};
