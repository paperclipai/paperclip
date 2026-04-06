import { api } from "./client";

export interface SandboxEnvironment {
  id: string;
  companyId: string;
  agentId: string | null;
  provider: string;
  sandboxId: string | null;
  status: string;
  region: string | null;
  template: string | null;
  timeoutSeconds: number;
  cpuMillicores: number;
  memoryMb: number;
  diskMb: number;
  ports: number[];
  envVars: Record<string, string>;
  sandboxUrl: string | null;
  terminalUrl: string | null;
  logsUrl: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSandboxInput {
  agentId?: string;
  provider?: string;
  region?: string;
  template?: string;
  timeoutSeconds?: number;
  cpuMillicores?: number;
  memoryMb?: number;
  diskMb?: number;
  ports?: number[];
  envVars?: Record<string, string>;
}

export const sandboxesApi = {
  list: (companyId: string, agentId?: string) =>
    api.get<SandboxEnvironment[]>(
      `/companies/${companyId}/sandboxes${agentId ? `?agentId=${agentId}` : ""}`
    ),
  get: (companyId: string, id: string) =>
    api.get<SandboxEnvironment>(`/companies/${companyId}/sandboxes/${id}`),
  create: (companyId: string, input: CreateSandboxInput) =>
    api.post<SandboxEnvironment>(`/companies/${companyId}/sandboxes`, input),
  start: (companyId: string, id: string) =>
    api.post<SandboxEnvironment>(`/companies/${companyId}/sandboxes/${id}/start`, {}),
  stop: (companyId: string, id: string) =>
    api.post<SandboxEnvironment>(`/companies/${companyId}/sandboxes/${id}/stop`, {}),
  remove: (companyId: string, id: string) =>
    api.delete(`/companies/${companyId}/sandboxes/${id}`),
  updateAgentConfig: (companyId: string, agentId: string, config: Record<string, unknown>) =>
    api.patch(`/companies/${companyId}/agents/${agentId}/sandbox-config`, config),
};
