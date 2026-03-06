import type {
  Agent,
  AdapterEnvironmentTestResult,
  AgentKeyCreated,
  AgentRuntimeState,
  AgentTaskSession,
  HeartbeatRun,
  Approval,
  AgentConfigRevision,
} from "@paperclipai/shared";
import { isUuidLike, normalizeAgentUrlKey } from "@paperclipai/shared";
import { ApiError, api } from "./client";

export interface AgentKey {
  id: string;
  name: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AdapterModel {
  id: string;
  label: string;
}

export interface ClaudeLoginResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  loginUrl: string | null;
  stdout: string;
  stderr: string;
}

export interface OrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  reports: OrgNode[];
}

export interface AgentHireResponse {
  agent: Agent;
  approval: Approval | null;
}

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function agentPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(`/agents/${encodeURIComponent(id)}${suffix}`, companyId);
}

export const agentsApi = {
  list: (companyId: string) => api.get<Agent[]>(`/companies/${companyId}/agents`),
  org: (companyId: string) => api.get<OrgNode[]>(`/companies/${companyId}/org`),
  listConfigurations: (companyId: string) =>
    api.get<Record<string, unknown>[]>(`/companies/${companyId}/agent-configurations`),
  get: async (id: string, companyId?: string) => {
    try {
      return await api.get<Agent>(agentPath(id, companyId));
    } catch (error) {
      // Backward-compat fallback: if backend shortname lookup reports ambiguity,
      // resolve using company agent list while ignoring terminated agents.
      if (
        !(error instanceof ApiError) ||
        error.status !== 409 ||
        !companyId ||
        isUuidLike(id)
      ) {
        throw error;
      }

      const urlKey = normalizeAgentUrlKey(id);
      if (!urlKey) throw error;

      const agents = await api.get<Agent[]>(`/companies/${companyId}/agents`);
      const matches = agents.filter(
        (agent) => agent.status !== "terminated" && normalizeAgentUrlKey(agent.urlKey) === urlKey,
      );
      if (matches.length !== 1) throw error;
      return api.get<Agent>(agentPath(matches[0]!.id, companyId));
    }
  },
  getConfiguration: (id: string, companyId?: string) =>
    api.get<Record<string, unknown>>(agentPath(id, companyId, "/configuration")),
  listConfigRevisions: (id: string, companyId?: string) =>
    api.get<AgentConfigRevision[]>(agentPath(id, companyId, "/config-revisions")),
  getConfigRevision: (id: string, revisionId: string, companyId?: string) =>
    api.get<AgentConfigRevision>(agentPath(id, companyId, `/config-revisions/${revisionId}`)),
  rollbackConfigRevision: (id: string, revisionId: string, companyId?: string) =>
    api.post<Agent>(agentPath(id, companyId, `/config-revisions/${revisionId}/rollback`), {}),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Agent>(`/companies/${companyId}/agents`, data),
  hire: (companyId: string, data: Record<string, unknown>) =>
    api.post<AgentHireResponse>(`/companies/${companyId}/agent-hires`, data),
  update: (id: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<Agent>(agentPath(id, companyId), data),
  updatePermissions: (id: string, data: { canCreateAgents: boolean }, companyId?: string) =>
    api.patch<Agent>(agentPath(id, companyId, "/permissions"), data),
  pause: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/pause"), {}),
  resume: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/resume"), {}),
  terminate: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/terminate"), {}),
  remove: (id: string, companyId?: string) => api.delete<{ ok: true }>(agentPath(id, companyId)),
  listKeys: (id: string, companyId?: string) => api.get<AgentKey[]>(agentPath(id, companyId, "/keys")),
  createKey: (id: string, name: string, companyId?: string) =>
    api.post<AgentKeyCreated>(agentPath(id, companyId, "/keys"), { name }),
  revokeKey: (agentId: string, keyId: string, companyId?: string) =>
    api.delete<{ ok: true }>(agentPath(agentId, companyId, `/keys/${encodeURIComponent(keyId)}`)),
  runtimeState: (id: string, companyId?: string) =>
    api.get<AgentRuntimeState>(agentPath(id, companyId, "/runtime-state")),
  taskSessions: (id: string, companyId?: string) =>
    api.get<AgentTaskSession[]>(agentPath(id, companyId, "/task-sessions")),
  resetSession: (id: string, taskKey?: string | null, companyId?: string) =>
    api.post<void>(agentPath(id, companyId, "/runtime-state/reset-session"), { taskKey: taskKey ?? null }),
  adapterModels: (companyId: string, type: string) =>
    api.get<AdapterModel[]>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/models`,
    ),
  testEnvironment: (
    companyId: string,
    type: string,
    data: { adapterConfig: Record<string, unknown> },
  ) =>
    api.post<AdapterEnvironmentTestResult>(
      `/companies/${companyId}/adapters/${type}/test-environment`,
      data,
    ),
  invoke: (id: string, companyId?: string) => api.post<HeartbeatRun>(agentPath(id, companyId, "/heartbeat/invoke"), {}),
  wakeup: (
    id: string,
    data: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
    },
    companyId?: string,
  ) => api.post<HeartbeatRun | { status: "skipped" }>(agentPath(id, companyId, "/wakeup"), data),
  loginWithClaude: (id: string, companyId?: string) =>
    api.post<ClaudeLoginResult>(agentPath(id, companyId, "/claude-login"), {}),
};
