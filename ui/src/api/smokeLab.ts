import type {
  CreateSmokeRun,
  RecordSmokeRunStep,
  SmokeLabServiceStatus,
  SmokeRun,
  SmokeRunStep,
  UpdateSmokeRun,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Smoke Lab API client (PAP-13347 / S2, plan §D3). Mirrors the S1 results API
 * shipped in `server/src/routes/smoke-lab.ts` (PAP-13346). Every endpoint is
 * company-scoped and gated server-side on `experimental.enableSmokeLab`,
 * `deploymentMode === local_trusted`, and a non-production environment — the UI
 * only ever surfaces these screens when the board-readable experimental flag is
 * on, but the server stays authoritative.
 */

export interface SmokeLabServicesResponse {
  services: SmokeLabServiceStatus[];
}

export interface SmokeLabInstallFixturesResponse {
  created: boolean;
  applications: Array<{ id: string; name: string }>;
  connections: Array<{ id: string; name: string }>;
  catalog: unknown[];
  profile: { id: string };
}

export interface SmokeLabRunsResponse {
  runs: SmokeRun[];
}

export interface SmokeLabRunDetailResponse {
  run: SmokeRun;
  steps: SmokeRunStep[];
}

const base = (companyId: string) => `/companies/${companyId}/smoke-lab`;

export const smokeLabApi = {
  listServices: (companyId: string) =>
    api.get<SmokeLabServicesResponse>(`${base(companyId)}/services`),
  startServices: (companyId: string) =>
    api.post<SmokeLabServicesResponse>(`${base(companyId)}/services/start`, {}),
  stopServices: (companyId: string) =>
    api.post<SmokeLabServicesResponse>(`${base(companyId)}/services/stop`, {}),
  installFixtures: (companyId: string) =>
    api.post<SmokeLabInstallFixturesResponse>(`${base(companyId)}/install-fixtures`, {}),
  reset: (companyId: string) =>
    api.post<{ reset: boolean }>(`${base(companyId)}/reset`, {}),

  listRuns: (companyId: string) =>
    api.get<SmokeLabRunsResponse>(`${base(companyId)}/runs`),
  getRun: (companyId: string, runId: string) =>
    api.get<SmokeLabRunDetailResponse>(`${base(companyId)}/runs/${runId}`),
  createRun: (companyId: string, input: CreateSmokeRun) =>
    api.post<{ run: SmokeRun }>(`${base(companyId)}/runs`, input),
  updateRun: (companyId: string, runId: string, input: UpdateSmokeRun) =>
    api.patch<{ run: SmokeRun }>(`${base(companyId)}/runs/${runId}`, input),
  recordStep: (companyId: string, runId: string, input: RecordSmokeRunStep) =>
    api.post<{ step: SmokeRunStep; summary: Record<string, unknown> }>(
      `${base(companyId)}/runs/${runId}/steps`,
      input,
    ),
};
