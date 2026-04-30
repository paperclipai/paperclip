import { api } from "./client";

export type CcrotateTarget = "claude" | "codex";

export interface CcrotateAccountRow {
  email: string;
  target: CcrotateTarget;
  tier: string;
  utilization5h: number | null;
  utilization7d: number | null;
  availability: string;
  isActive: boolean;
  isHealthy: boolean;
}

export interface CcrotateSnapshotResponse {
  fetchedAt: string;
  cacheAge: string | null;
  targets: Record<CcrotateTarget, { error?: string; accounts?: CcrotateAccountRow[] }>;
}

const BASE = "/plugins/kkroo.ccrotate/api";

export const ccrotateApi = {
  snapshot: (companyId: string) =>
    api.get<CcrotateSnapshotResponse>(
      `${BASE}/snapshot?companyId=${encodeURIComponent(companyId)}`,
    ),
};
