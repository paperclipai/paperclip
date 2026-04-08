import { api } from "./client";

/**
 * Phase 4: leader CLI lifecycle API client.
 * @see server/src/routes/leader-processes.ts
 */

export type LeaderProcessStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed";

export interface LeaderProcessRow {
  id: string;
  companyId: string;
  agentId: string;
  sessionId: string | null;
  status: LeaderProcessStatus;
  pm2Name: string | null;
  pm2PmId: number | null;
  pid: number | null;
  agentKeyId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastHeartbeatAt: string | null;
  exitCode: number | null;
  exitReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderProcessStatusDetail {
  row: LeaderProcessRow | null;
  alive: boolean;
}

export interface LeaderProcessLogs {
  lines: string[];
}

export const leaderProcessesApi = {
  start: (companyId: string, agentId: string) =>
    api.post<LeaderProcessRow>(
      `/companies/${companyId}/agents/${agentId}/cli/start`,
      {},
    ),
  stop: (companyId: string, agentId: string, timeoutMs?: number) =>
    api.post<LeaderProcessRow>(
      `/companies/${companyId}/agents/${agentId}/cli/stop`,
      timeoutMs !== undefined ? { timeoutMs } : {},
    ),
  restart: (companyId: string, agentId: string) =>
    api.post<LeaderProcessRow>(
      `/companies/${companyId}/agents/${agentId}/cli/restart`,
      {},
    ),
  status: (companyId: string, agentId: string) =>
    api.get<LeaderProcessStatusDetail>(
      `/companies/${companyId}/agents/${agentId}/cli/status`,
    ),
  logs: (
    companyId: string,
    agentId: string,
    opts?: { kind?: "out" | "err"; lines?: number },
  ) => {
    const params = new URLSearchParams();
    if (opts?.kind) params.set("kind", opts.kind);
    if (opts?.lines) params.set("lines", String(opts.lines));
    const qs = params.toString();
    return api.get<LeaderProcessLogs>(
      `/companies/${companyId}/agents/${agentId}/cli/logs${qs ? `?${qs}` : ""}`,
    );
  },
  listForCompany: (companyId: string) =>
    api.get<LeaderProcessRow[]>(`/companies/${companyId}/leader-processes`),
};
