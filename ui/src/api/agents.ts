import type {
  Agent,
  AgentDesiredSkillEntry,
  AgentSkillAssignmentMode,
  AgentPermissions,
  AgentDetail,
  AgentInstructionsBundle,
  AgentInstructionsFileDetail,
  AgentSkillSnapshot,
  AdapterEnvironmentTestResult,
  AdapterAuthSignalResponse,
  AdapterAuthSessionResponse,
  AdapterAuthSessionOwnerResponse,
  ClaudeSetupTokenSessionResponse,
  ClaudeSetupTokenSessionOwnerResponse,
  ClaudeSetupTokenSessionPrompt,
  ClaudeSetupTokenCompletionResponse,
  ClaudeSetupTokenOverwrite,
  ClaudeOAuthTokenStatusResponse,
  SubmitBrowserCodeRequest,
  AgentKeyCreated,
  AgentRuntimeState,
  AgentTaskSession,
  AgentWakeupResponse,
  HeartbeatRun,
  Approval,
  AgentConfigRevision,
  ClearAgentErrorResponse,
  AgentApiKeyScope,
} from "@paperclipai/shared";
import type {
  AdapterModelProfileDefinition,
  AdapterModelProfileKey,
} from "@paperclipai/adapter-utils";
import { isUuidLike, normalizeAgentUrlKey } from "@paperclipai/shared";
import { ApiError, api } from "./client";

export interface AgentKey {
  id: string;
  name: string;
  scope: AgentApiKeyScope;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AdapterModel {
  id: string;
  label: string;
}

export type { AdapterModelProfileKey };
export type AdapterModelProfile = AdapterModelProfileDefinition;

export interface DetectedAdapterModel {
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
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

export interface AgentPermissionUpdate {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
  canAssignTasks: boolean;
  trustPreset?: AgentPermissions["trustPreset"];
  authorizationPolicy?: AgentPermissions["authorizationPolicy"];
}

export interface AgentWakeRequest {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  forceFreshSession?: boolean;
  debug?: { providerTrace: "raw" };
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
      return await api.get<AgentDetail>(agentPath(id, companyId));
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
      return api.get<AgentDetail>(agentPath(matches[0]!.id, companyId));
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
  updatePermissions: (id: string, data: AgentPermissionUpdate, companyId?: string) =>
    api.patch<AgentDetail>(agentPath(id, companyId, "/permissions"), data),
  instructionsBundle: (id: string, companyId?: string) =>
    api.get<AgentInstructionsBundle>(agentPath(id, companyId, "/instructions-bundle")),
  updateInstructionsBundle: (
    id: string,
    data: {
      mode?: "managed" | "external";
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    },
    companyId?: string,
  ) => api.patch<AgentInstructionsBundle>(agentPath(id, companyId, "/instructions-bundle"), data),
  instructionsFile: (id: string, relativePath: string, companyId?: string) =>
    api.get<AgentInstructionsFileDetail>(
      agentPath(id, companyId, `/instructions-bundle/file?path=${encodeURIComponent(relativePath)}`),
    ),
  saveInstructionsFile: (
    id: string,
    data: { path: string; content: string; clearLegacyPromptTemplate?: boolean },
    companyId?: string,
  ) => api.put<AgentInstructionsFileDetail>(agentPath(id, companyId, "/instructions-bundle/file"), data),
  deleteInstructionsFile: (id: string, relativePath: string, companyId?: string) =>
    api.delete<AgentInstructionsBundle>(
      agentPath(id, companyId, `/instructions-bundle/file?path=${encodeURIComponent(relativePath)}`),
    ),
  pause: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/pause"), {}),
  resume: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/resume"), {}),
  clearError: (id: string, companyId?: string) =>
    api.post<ClearAgentErrorResponse>(agentPath(id, companyId, "/clear-error"), {}),
  approve: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/approve"), {}),
  terminate: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/terminate"), {}),
  remove: (id: string, companyId?: string) => api.delete<{ ok: true }>(agentPath(id, companyId)),
  listKeys: (id: string, companyId?: string) => api.get<AgentKey[]>(agentPath(id, companyId, "/keys")),
  skills: (id: string, companyId?: string) =>
    api.get<AgentSkillSnapshot>(agentPath(id, companyId, "/skills")),
  syncSkills: (
    id: string,
    desiredSkills: Array<string | AgentDesiredSkillEntry>,
    mode: AgentSkillAssignmentMode,
    companyId?: string,
  ) => api.post<AgentSkillSnapshot>(agentPath(id, companyId, "/skills/sync"), { desiredSkills, mode }),
  createKey: (id: string, name: string, companyId?: string, scope?: AgentApiKeyScope) =>
    api.post<AgentKeyCreated>(agentPath(id, companyId, "/keys"), { name, ...(scope ? { scope } : {}) }),
  revokeKey: (agentId: string, keyId: string, companyId?: string) =>
    api.delete<{ ok: true }>(agentPath(agentId, companyId, `/keys/${encodeURIComponent(keyId)}`)),
  runtimeState: (id: string, companyId?: string) =>
    api.get<AgentRuntimeState>(agentPath(id, companyId, "/runtime-state")),
  taskSessions: (id: string, companyId?: string) =>
    api.get<AgentTaskSession[]>(agentPath(id, companyId, "/task-sessions")),
  resetSession: (id: string, taskKey?: string | null, companyId?: string) =>
    api.post<void>(agentPath(id, companyId, "/runtime-state/reset-session"), { taskKey: taskKey ?? null }),
  adapterModels: (
    companyId: string,
    type: string,
    options?: { refresh?: boolean; environmentId?: string | null },
  ) => {
    const params = new URLSearchParams();
    if (options?.refresh) params.set("refresh", "1");
    if (options?.environmentId) params.set("environmentId", options.environmentId);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return api.get<AdapterModel[]>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/models${query}`,
    );
  },
  detectModel: (companyId: string, type: string) =>
    api.get<DetectedAdapterModel | null>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/detect-model`,
    ),
  adapterModelProfiles: (companyId: string, type: string) =>
    api.get<AdapterModelProfile[]>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/model-profiles`,
    ),
  testEnvironment: (
    companyId: string,
    type: string,
    data: {
      adapterConfig: Record<string, unknown>;
      environmentId?: string | null;
    },
  ) =>
    api.post<AdapterEnvironmentTestResult>(
      `/companies/${companyId}/adapters/${type}/test-environment`,
      data,
    ),
  getAdapterAuthSignal: (companyId: string, type: string, environmentId?: string | null) => {
    const query = environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : "";
    return api.get<AdapterAuthSignalResponse>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/auth-signal${query}`,
    );
  },
  invoke: (id: string, companyId?: string, data: AgentWakeRequest = {}) =>
    api.post<HeartbeatRun>(agentPath(id, companyId, "/heartbeat/invoke"), data),
  wakeup: (
    id: string,
    data: AgentWakeRequest,
    companyId?: string,
  ) => api.post<AgentWakeupResponse>(agentPath(id, companyId, "/wakeup"), data),
  loginWithClaude: (id: string, companyId?: string) =>
    api.post<ClaudeLoginResult>(agentPath(id, companyId, "/claude-login"), {}),
  startAdapterAuthLogin: (
    companyId: string,
    type: string,
    data: { environmentId: string; ttlSeconds?: number },
  ) =>
    api.post<AdapterAuthSessionResponse>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/login-sessions`,
      data,
    ),
  getAdapterAuthLoginStatus: (companyId: string, type: string, sessionId: string) =>
    api.get<AdapterAuthSessionOwnerResponse>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/login-sessions/${encodeURIComponent(sessionId)}`,
    ),
  cancelAdapterAuthLogin: (companyId: string, type: string, sessionId: string) =>
    api.post<AdapterAuthSessionOwnerResponse>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/login-sessions/${encodeURIComponent(sessionId)}/cancel`,
      {},
    ),
  // The Claude submitted-browser-code login uses the company-and-environment
  // setup-token routes. The route fixes the `claude_local` adapter. The start
  // response carries the panel mode; the authorization URL rides only through the
  // guarded prompt read. The completion response carries a non-secret
  // `storedSessionId` claim and no token.
  // Reads the stored Claude OAuth token status for the authenticated owner. A
  // 200 carries only the secret id and the latest version; a 404 means the owner
  // has no stored value (indistinguishable from a foreign value). The client
  // applies the stored token first and captures the version for a later
  // version-checked overwrite.
  getClaudeOAuthTokenStatus: (companyId: string) =>
    api.get<ClaudeOAuthTokenStatusResponse>(
      `/companies/${encodeURIComponent(companyId)}/claude-oauth-token-status`,
    ),
  startClaudeSetupTokenLogin: (
    companyId: string,
    data: { environmentId: string; overwrite?: ClaudeSetupTokenOverwrite },
  ) =>
    api.post<ClaudeSetupTokenSessionOwnerResponse>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions`,
      { adapterType: "claude_local", ...data },
    ),
  getClaudeSetupTokenLoginStatus: (companyId: string, sessionId: string) =>
    api.get<ClaudeSetupTokenSessionResponse>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/${encodeURIComponent(sessionId)}`,
    ),
  getClaudeSetupTokenLoginPrompt: (companyId: string, sessionId: string) =>
    api.get<ClaudeSetupTokenSessionPrompt>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/${encodeURIComponent(sessionId)}/prompt`,
    ),
  submitClaudeSetupTokenBrowserCode: (companyId: string, sessionId: string, browserCode: string) =>
    api.post<ClaudeSetupTokenSessionResponse>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/${encodeURIComponent(sessionId)}/code`,
      { browserCode } satisfies SubmitBrowserCodeRequest,
    ),
  completeClaudeSetupTokenLogin: (companyId: string, sessionId: string) =>
    api.post<ClaudeSetupTokenCompletionResponse>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/${encodeURIComponent(sessionId)}/completion`,
      {},
    ),
  cancelClaudeSetupTokenLogin: (companyId: string, sessionId: string) =>
    api.post<void>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/${encodeURIComponent(sessionId)}/cancel`,
      {},
    ),
  availableSkills: () =>
    api.get<{ skills: AvailableSkill[] }>("/skills/available"),
};

export interface AvailableSkill {
  name: string;
  description: string;
  isPaperclipManaged: boolean;
}
