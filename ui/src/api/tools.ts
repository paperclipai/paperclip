import type {
  ToolApplication,
  ToolConnection,
  ToolCatalogEntry,
  ToolRuntimeSlot,
  ToolPolicy,
  ToolConnectionHealthCheckResult,
  ToolCatalogRefreshResult,
  ToolAccessDecision,
  ToolAccessDecisionInput,
  CreateToolPolicy,
  McpJsonImportPreview,
  ToolRuntimeHealthSummary,
  ToolRunDecisionLookup,
  ToolExampleInstallResult,
  ToolExampleSmokeResult,
  ToolExampleSummary,
  ToolProfileBinding,
  ToolProfileBindingTargetType,
  ToolProfileDefaultAction,
  ToolProfileEffectiveSummary,
  ToolProfileEntry,
  ToolProfileEntryEffect,
  ToolProfileEntrySelectorType,
  ToolProfileStatus,
  ToolProfileWithDetails,
  ToolRiskLevel,
  UpdateToolPolicy,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Tools & Access API client (Phase 6, PAP-10389).
 *
 * Mirrors the governed MCP/tool-access contracts shipped by Phases 2-5
 * (`server/src/routes/tool-access.ts` and `tool-gateway.ts`). The UI consumes
 * server-side enforcement contracts directly instead of faking tool access in
 * the browser.
 */

export type ToolApplicationsResponse = { applications: ToolApplication[] };
export type ToolConnectionsResponse = { connections: ToolConnection[] };
export type ToolCatalogResponse = { catalog: ToolCatalogEntry[] };
export type ToolRuntimeSlotsResponse = { runtimeSlots: ToolRuntimeSlot[] };
export type ToolRuntimeHealthResponse = ToolRuntimeHealthSummary;
export type ToolTrustRulesResponse = { trustRules: ToolPolicy[] };
export type ToolPoliciesResponse = { policies: ToolPolicy[] };
export type ToolExamplesResponse = { examples: ToolExampleSummary[] };
export type ToolProfilesResponse = { profiles: ToolProfileWithDetails[] };

export interface StdioTemplateSummary {
  templateId: string;
  title?: string;
  description?: string;
  tools?: Array<{ name: string; description?: string }>;
  [key: string]: unknown;
}
export type StdioTemplatesResponse = { templates: StdioTemplateSummary[] };

export interface CreateToolApplicationInput {
  name: string;
  description?: string | null;
  type: ToolApplication["type"];
  pluginId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateToolApplicationInput {
  name?: string;
  description?: string | null;
  status?: ToolApplication["status"];
  metadata?: Record<string, unknown> | null;
}

export interface CreateToolConnectionInput {
  applicationId?: string;
  applicationName?: string;
  name: string;
  transport: NonNullable<ToolConnection["transport"]>;
  status?: ToolConnection["status"];
  config?: Record<string, unknown>;
  credentialRefs?: ToolConnection["credentialRefs"];
  enabled?: boolean;
}

export interface UpdateToolConnectionInput {
  name?: string;
  status?: ToolConnection["status"];
  config?: Record<string, unknown>;
  credentialRefs?: ToolConnection["credentialRefs"];
  enabled?: boolean;
}

export interface ToolProfileEntryInput {
  selectorType: ToolProfileEntrySelectorType;
  effect?: ToolProfileEntryEffect;
  applicationId?: string | null;
  connectionId?: string | null;
  catalogEntryId?: string | null;
  toolName?: string | null;
  riskLevel?: ToolRiskLevel | null;
  conditions?: Record<string, unknown> | null;
}

export interface CreateToolProfileInput {
  profileKey: string;
  name: string;
  description?: string | null;
  status?: ToolProfileStatus;
  defaultAction?: ToolProfileDefaultAction;
  metadata?: Record<string, unknown> | null;
  entries?: ToolProfileEntryInput[];
}

export interface UpdateToolProfileInput {
  profileKey?: string;
  name?: string;
  description?: string | null;
  status?: ToolProfileStatus;
  defaultAction?: ToolProfileDefaultAction;
  metadata?: Record<string, unknown> | null;
  entries?: ToolProfileEntryInput[];
}

export interface ToolProfileBindingInput {
  targetType: ToolProfileBindingTargetType;
  targetId: string;
  priority?: number;
  metadata?: Record<string, unknown> | null;
}

export type UnbindToolProfileInput = Pick<ToolProfileBindingInput, "targetType" | "targetId">;

/** Redacted tool-gateway audit row (subset of `activity_log`). */
export interface ToolGatewayAuditRow {
  id: string;
  companyId: string;
  action: string;
  actorType: string | null;
  actorId: string | null;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export type ToolPolicyTestResponse = {
  decision: ToolAccessDecision;
  auditEvent: unknown | null;
};

export const toolsApi = {
  // --- Examples ---
  listExamples: (companyId: string) =>
    api.get<ToolExamplesResponse>(`/companies/${companyId}/tools/examples`),
  installExample: (companyId: string, exampleId: string) =>
    api.post<ToolExampleInstallResult>(`/companies/${companyId}/tools/examples/${exampleId}/install`, {}),
  smokeExample: (companyId: string, exampleId: string) =>
    api.post<ToolExampleSmokeResult>(`/companies/${companyId}/tools/examples/${exampleId}/smoke`, {}),

  // --- Applications ---
  listApplications: (companyId: string) =>
    api.get<ToolApplicationsResponse>(`/companies/${companyId}/tools/applications`),
  createApplication: (companyId: string, input: CreateToolApplicationInput) =>
    api.post<ToolApplication>(`/companies/${companyId}/tools/applications`, input),
  updateApplication: (applicationId: string, input: UpdateToolApplicationInput) =>
    api.patch<ToolApplication>(`/tool-applications/${applicationId}`, input),
  deleteApplication: (applicationId: string) =>
    api.delete<ToolApplication>(`/tool-applications/${applicationId}`),

  // --- Connections ---
  listConnections: (companyId: string) =>
    api.get<ToolConnectionsResponse>(`/companies/${companyId}/tools/connections`),
  getConnection: (connectionId: string) =>
    api.get<ToolConnection>(`/tool-connections/${connectionId}`),
  createConnection: (companyId: string, input: CreateToolConnectionInput) =>
    api.post<ToolConnection>(`/companies/${companyId}/tools/connections`, input),
  updateConnection: (connectionId: string, input: UpdateToolConnectionInput) =>
    api.patch<ToolConnection>(`/tool-connections/${connectionId}`, input),
  archiveConnection: (connectionId: string) =>
    api.delete<ToolConnection>(`/tool-connections/${connectionId}`),
  checkConnectionHealth: (connectionId: string) =>
    api.post<ToolConnectionHealthCheckResult>(`/tool-connections/${connectionId}/health-check`, {}),
  refreshCatalog: (connectionId: string) =>
    api.post<ToolCatalogRefreshResult>(`/tool-connections/${connectionId}/catalog/refresh`, {}),
  listCatalog: (connectionId: string) =>
    api.get<ToolCatalogResponse>(`/tool-connections/${connectionId}/catalog`),
  importMcpJson: (companyId: string, body: { mcpJson: unknown }) =>
    api.post<McpJsonImportPreview>(`/companies/${companyId}/tools/mcp/import-json`, body),
  listStdioTemplates: (companyId: string) =>
    api.get<StdioTemplatesResponse>(`/companies/${companyId}/tools/stdio-templates`),

  // --- Profiles ---
  listProfiles: (companyId: string) =>
    api.get<ToolProfilesResponse>(`/companies/${companyId}/tools/profiles`),
  createProfile: (companyId: string, input: CreateToolProfileInput) =>
    api.post<ToolProfileWithDetails>(`/companies/${companyId}/tools/profiles`, input),
  updateProfile: (profileId: string, input: UpdateToolProfileInput) =>
    api.patch<ToolProfileWithDetails>(`/tool-profiles/${profileId}`, input),
  addProfileEntry: (profileId: string, input: ToolProfileEntryInput) =>
    api.post<ToolProfileEntry>(`/tool-profiles/${profileId}/entries`, input),
  updateProfileEntry: (entryId: string, input: Partial<ToolProfileEntryInput>) =>
    api.patch<ToolProfileEntry>(`/tool-profile-entries/${entryId}`, input),
  deleteProfileEntry: (entryId: string) =>
    api.delete<ToolProfileEntry>(`/tool-profile-entries/${entryId}`),
  bindProfile: (companyId: string, profileId: string, input: ToolProfileBindingInput) =>
    api.post<ToolProfileBinding>(`/companies/${companyId}/tools/profiles/${profileId}/bind`, input),
  unbindProfile: (companyId: string, profileId: string, input: UnbindToolProfileInput) =>
    api.post<{ unbound: number }>(`/companies/${companyId}/tools/profiles/${profileId}/unbind`, input),
  getEffectiveProfilesForAgent: (companyId: string, agentId: string) =>
    api.get<ToolProfileEffectiveSummary>(
      `/companies/${companyId}/tools/profiles/effective/agents/${encodeURIComponent(agentId)}`,
    ),

  // --- Runtime ---
  listRuntimeSlots: (companyId: string) =>
    api.get<ToolRuntimeSlotsResponse>(`/companies/${companyId}/tools/runtime-slots`),
  stopRuntimeSlot: (companyId: string, slotId: string) =>
    api.post<ToolRuntimeSlot>(`/companies/${companyId}/tools/runtime-slots/${slotId}/stop`, {}),
  restartRuntimeSlot: (companyId: string, slotId: string) =>
    api.post<ToolRuntimeSlot>(`/companies/${companyId}/tools/runtime-slots/${slotId}/restart`, {}),
  getRuntimeHealth: (companyId: string) =>
    api.get<ToolRuntimeHealthResponse>(`/companies/${companyId}/tools/runtime-health`),
  getRunDecisionLookup: (companyId: string, runId: string) =>
    api.get<ToolRunDecisionLookup>(`/companies/${companyId}/tools/runs/${runId}/decisions`),
  listLiveRuntimeSlots: (companyId: string) =>
    api.get<ToolRuntimeSlot[]>(`/tool-gateway/runtime-slots?companyId=${encodeURIComponent(companyId)}`),

  // --- Policies (trust rules + decision simulator) ---
  listPolicies: (companyId: string) =>
    api.get<ToolPoliciesResponse>(`/companies/${companyId}/tools/policies`),
  createPolicy: (companyId: string, input: CreateToolPolicy) =>
    api.post<ToolPolicy>(`/companies/${companyId}/tools/policies`, input),
  updatePolicy: (companyId: string, policyId: string, input: UpdateToolPolicy) =>
    api.patch<ToolPolicy>(`/companies/${companyId}/tools/policies/${policyId}`, input),
  deletePolicy: (companyId: string, policyId: string) =>
    api.delete<ToolPolicy>(`/companies/${companyId}/tools/policies/${policyId}`),
  listTrustRules: (companyId: string) =>
    api.get<ToolTrustRulesResponse>(`/companies/${companyId}/tools/trust-rules`),
  revokeTrustRule: (companyId: string, policyId: string, reason?: string | null) =>
    api.post<ToolPolicy>(`/companies/${companyId}/tools/trust-rules/${policyId}/revoke`, {
      reason: reason ?? null,
    }),
  testPolicy: (companyId: string, input: Omit<ToolAccessDecisionInput, "companyId">) =>
    api.post<ToolPolicyTestResponse>(`/companies/${companyId}/tools/policy/test`, input),

  // --- Audit ---
  listAudit: (companyId: string, limit = 100) =>
    api.get<ToolGatewayAuditRow[]>(
      `/tool-gateway/audit?companyId=${encodeURIComponent(companyId)}&limit=${limit}`,
    ),
};
