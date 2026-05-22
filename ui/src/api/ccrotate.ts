import { api } from "./client";

export type CcrotateTarget = "claude" | "codex";

export interface CcrotateAccountRow {
  email: string;
  target: CcrotateTarget;
  tier: string;
  utilization5h: number | null;
  utilization7d: number | null;
  utilization7dSonnet: number | null;
  utilization7dOpus: number | null;
  availability: string;
  apiLimit: string | null;
  isActive: boolean;
  isHealthy: boolean;
}

export interface CcrotateSnapshotResponse {
  fetchedAt: string;
  cacheAge: string | null;
  targets: Record<CcrotateTarget, { error?: string; accounts?: CcrotateAccountRow[] }>;
}

export interface CcrotateRefreshResponse {
  ok: boolean;
  errors?: Array<{ target: CcrotateTarget; error: string }>;
}

export interface CcrotateImportResponse {
  ok: boolean;
  imported?: { updated: number; kept: number };
  capturedAt?: string;
}

const BASE = "/plugins/kkroo.ccrotate/api";

export const ccrotateApi = {
  snapshot: (companyId: string) =>
    api.get<CcrotateSnapshotResponse>(
      `${BASE}/snapshot?companyId=${encodeURIComponent(companyId)}`,
    ),
  refresh: (companyId: string) =>
    api.post<CcrotateRefreshResponse>(`${BASE}/refresh`, { companyId }),
  import: (companyId: string, blob: string) =>
    api.post<CcrotateImportResponse>(`${BASE}/import`, { companyId, blob }),
};
