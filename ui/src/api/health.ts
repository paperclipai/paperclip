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
    emailEnabled?: boolean;
    socialProviders?: string[];
    cloudSandboxEnabled?: boolean;
    managedInferenceEnabled?: boolean;
  };
  devServer?: DevServerHealthStatus;
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const detailsRes = await fetch("/api/health/details", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (detailsRes.ok) return detailsRes.json();
    // Fall back to public health (no auth) to at least get deploymentMode
    const publicRes = await fetch("/api/health", {
      headers: { Accept: "application/json" },
    });
    if (publicRes.ok) return publicRes.json();
    throw new Error("Failed to load health");
  },
};
