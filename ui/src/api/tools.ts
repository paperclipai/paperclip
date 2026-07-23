import type {
  CreateConnectionTrigger,
  UpdateConnectionTrigger,
  ToolApplication,
  ToolConnection,
  ToolConnectionInstall,
  ToolConnectionInstallSnapshot,
  ConnectToolAppResult,
  FinishToolAppResult,
  ToolCatalogEntry,
  ToolRuntimeSlot,
  ToolPolicy,
  ToolConnectionHealthCheckResult,
  ToolCatalogRefreshResult,
  ToolAccessDecision,
  ToolAccessDecisionInput,
  CreateToolPolicy,
  DuplicateToolPolicy,
  McpJsonImportPreview,
  ToolRuntimeHealthSummary,
  ToolRunDecisionLookup,
  ToolOAuthStartResult,
  ToolStdioCommandTemplate,
  ToolProfileBinding,
  ToolProfileBindingTargetType,
  ToolProfileDefaultAction,
  ToolProfileEffectiveSummary,
  ToolProfileEntry,
  ToolProfileEntryEffect,
  ToolProfileEntrySelectorType,
  ToolProfileStatus,
  ToolProfileWithDetails,
  ToolProfileNewToolReviewDecision,
  ToolProfileNewToolsReview,
  ToolProfileNewToolsReviewResult,
  ToolRiskLevel,
  UpdateToolPolicy,
  ReorderToolPolicies,
  AppDefinition,
  ConnectionMethodDef,
  ToolAppsAttentionResponse,
  ToolConnectionActivityResponse,
  ToolConnectionTestAgentsResponse,
  ToolConnectionTestCallResult,
  ToolConnectionTestCallStatus,
  ToolActionRequest,
  ToolActionRequestStatus,
  ToolActionRequestsResponse,
  ToolMcpGatewayWithTokens,
  ToolMcpGatewayTokenCreated,
  ToolMcpGatewayToken,
  CreateToolMcpGateway,
  CreateToolMcpGatewayToken,
  UpdateToolMcpGateway,
  CreateToolTrustRuleFromActionRequest,
  ConnectionGrant,
  ConnectionGrantsResponse,
  ConnectionUsageResponse,
  StartConnectionAuthorizationRequest,
  StartConnectionAuthorizationResponse,
  ToolCredentialSecretRef,
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
export type ToolProfilesResponse = { profiles: ToolProfileWithDetails[] };
export type ToolGalleryResponse = { apps: AppDefinition[] };
export type ToolMcpGatewaysResponse = { gateways: ToolMcpGatewayWithTokens[] };
export type CreateGatewayTokenInput = Omit<CreateToolMcpGatewayToken, "expiresAt"> & {
  expiresAt?: string | Date | null;
};
/** Gateway update payload — `companyId` is injected by the client method. */
export type UpdateGatewayInput = Omit<UpdateToolMcpGateway, "companyId">;
export type ReviewNewToolsInput = {
  decisions: Array<{ catalogEntryId: string; decision: ToolProfileNewToolReviewDecision }>;
};

export type StdioTemplateSummary = ToolStdioCommandTemplate;
export type StdioTemplatesResponse = { templates: StdioTemplateSummary[] };

// --- Connection triggers + delivery relay (Connections v3, PAP-14832 P6c) ---

export type ConnectionTriggerDestinationType = "routine" | "issue_wake" | "plugin_worker";

/** A persisted inbound-webhook route from a connection to a destination. */
export interface ConnectionTriggerRecord {
  id: string;
  companyId: string;
  connectionId: string;
  destinationType: ConnectionTriggerDestinationType;
  destinationId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ConnectionTriggersResponse = {
  connectionId: string;
  triggers: ConnectionTriggerRecord[];
};

/** A delivery that exhausted its retries and landed in the dead-letter queue. */
export interface ConnectionTriggerDeadLetter {
  id: string;
  deliveryId: string;
  providerSlug: string;
  attempt: number;
  lastError: string | null;
  receivedAt: string;
}

export interface ConnectionTriggerDeliverySummary {
  counts: { received: number; forwarded: number; delivered: number; failed: number; deadLetter: number };
  lastError: { message: string; at: string; deliveryId: string } | null;
  deadLetters: ConnectionTriggerDeadLetter[];
}

export type ConnectionTriggerDeliveriesResponse = {
  connectionId: string;
  summary: ConnectionTriggerDeliverySummary;
};

/** Admin "run your own" command-template create input (M8b, PAP-10862). */
export interface CreateStdioTemplateInput {
  templateId: string;
  name: string;
  description?: string | null;
  command: string;
  args?: string[];
  envKeys?: string[];
}

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
  transportConfig?: Record<string, unknown>;
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

/** Normalized outcome for the humanized Activity feed. */
export type ToolAuditOutcome =
  | "allowed"
  | "blocked"
  | "asked_first"
  | "waiting"
  | "failed"
  | "unknown";

/**
 * Audit row enriched server-side with humanized display names and a normalized
 * outcome — the shape returned by `GET /tool-gateway/audit`.
 */
export interface ToolGatewayActivityEvent extends ToolGatewayAuditRow {
  agentId: string | null;
  runId: string | null;
  applicationId: string | null;
  connectionId: string | null;
  agentDisplayName: string | null;
  appDisplayName: string | null;
  applicationDisplayName: string | null;
  connectionDisplayName: string | null;
  toolDisplayName: string | null;
  normalizedOutcome: ToolAuditOutcome;
}

export type ToolGatewayActivityResponse = {
  events: ToolGatewayActivityEvent[];
  nextCursor: string | null;
};

export type ToolAuditWindow = "1h" | "24h" | "7d" | "30d";

export interface ListActivityParams {
  app?: string | null;
  agent?: string | null;
  outcome?: string | null;
  window?: ToolAuditWindow;
  search?: string | null;
  limit?: number;
  cursor?: string | null;
}

export type ToolPolicyTestResponse = {
  decision: ToolAccessDecision;
  auditEvent: unknown | null;
};

/**
 * Defensive normalization for the tools gallery (PAP-14882).
 *
 * The `tools/gallery` response is untrusted at render time: a stale or partial
 * backend can omit array fields (`categories`, `methods`, `urlPatterns`) or the
 * `branding` object. Browse, the Add-Connection wizard, and the shared
 * `getAvailableConnectionMethod`/`findAppByLink` helpers all iterate those
 * fields unguarded, so a malformed entry blanks the whole page with
 * `x is not iterable` instead of degrading. We harden once here at the trust
 * boundary: coerce the iterated fields to arrays/objects, drop entries that are
 * structurally unusable (no slug/name, or no connectable method), and de-dupe
 * by slug — so a bad entry is skipped, not fatal.
 */
export function normalizeGalleryApps(response: unknown): AppDefinition[] {
  const apps = (response as ToolGalleryResponse | null | undefined)?.apps;
  if (!Array.isArray(apps)) return [];
  const seen = new Set<string>();
  const out: AppDefinition[] = [];
  for (const raw of apps) {
    const app = normalizeGalleryApp(raw);
    if (!app || seen.has(app.slug)) continue;
    seen.add(app.slug);
    out.push(app);
  }
  return out;
}

function normalizeGalleryApp(raw: unknown): AppDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const app = raw as Record<string, unknown>;
  if (typeof app.slug !== "string" || typeof app.name !== "string") return null;

  // Methods drive the entire connect flow — an entry with none is not
  // connectable, so skip it rather than dead-ending the wizard.
  const rawMethods: unknown[] = Array.isArray(app.methods) ? app.methods : [];
  const methods = rawMethods
    .filter((m): m is ConnectionMethodDef => !!m && typeof m === "object")
    .map((m) => ({
      ...m,
      // getAvailableConnectionMethod iterates this per method.
      ownershipModes: Array.isArray(m.ownershipModes) ? m.ownershipModes : [],
    }));
  if (methods.length === 0) return null;

  const branding =
    app.branding && typeof app.branding === "object"
      ? (app.branding as AppDefinition["branding"])
      : { logoUrl: "" };

  return {
    ...(app as unknown as AppDefinition),
    categories: Array.isArray(app.categories) ? (app.categories as AppDefinition["categories"]) : [],
    urlPatterns: Array.isArray(app.urlPatterns) ? (app.urlPatterns as string[]) : [],
    methods,
    branding,
  };
}

export const toolsApi = {
  // --- Applications ---
  listGallery: (companyId: string): Promise<ToolGalleryResponse> =>
    api
      .get<ToolGalleryResponse>(`/companies/${companyId}/tools/gallery`)
      .then((res) => ({ apps: normalizeGalleryApps(res) })),
  connectApp: (companyId: string, input: {
    galleryKey?: string;
    link?: string;
    name?: string;
    methodKey?: string;
    ownership?: import("@paperclipai/shared").ToolConnectionOwnership;
    credentialValues?: Record<string, string>;
    configValues?: Record<string, unknown>;
    applicationId?: string;
  }) =>
    api.post<ConnectToolAppResult>(`/companies/${companyId}/tools/apps/connect`, input),
  startOAuth: (connectionId: string) =>
    api.post<ToolOAuthStartResult>(`/tools/oauth/${connectionId}/start`, {}),
  finishApp: (companyId: string, connectionId: string, input: {
    enabledCatalogEntryIds: string[];
    askFirstCatalogEntryIds: string[];
    access: "all_agents" | { agentIds: string[] };
  }) =>
    api.post<FinishToolAppResult>(
      `/companies/${companyId}/tools/apps/${connectionId}/finish`,
      input,
    ),
  listAppsAttention: (companyId: string) =>
    api.get<ToolAppsAttentionResponse>(`/companies/${companyId}/tools/apps/attention`),
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
  // --- Installs (Phase 3b, PAP-13618): which agents carry this connection's
  // tools in their runtime context. `installed ⊆ permitted`; the server
  // auto-extends access (adds profile bindings) for any newly-installed target.
  getConnectionInstalls: (connectionId: string) =>
    api.get<{ connectionId: string; installs: ToolConnectionInstall[] }>(
      `/tool-connections/${connectionId}/installs`,
    ),
  putConnectionInstalls: (
    connectionId: string,
    installs: Array<{ targetType: "company" | "agent"; targetId: string }>,
  ) =>
    api.put<ToolConnectionInstallSnapshot>(
      `/tool-connections/${connectionId}/installs`,
      { installs },
    ),
  createConnection: (companyId: string, input: CreateToolConnectionInput) =>
    api.post<ToolConnection>(`/companies/${companyId}/tools/connections`, input),
  updateConnection: (connectionId: string, input: UpdateToolConnectionInput) =>
    api.patch<ToolConnection>(`/tool-connections/${connectionId}`, input),
  archiveConnection: (connectionId: string) =>
    api.delete<ToolConnection>(`/tool-connections/${connectionId}`),
  checkConnectionHealth: (connectionId: string) =>
    api.post<ToolConnectionHealthCheckResult>(`/tool-connections/${connectionId}/health-check`, {}),
  reconnectConnection: (connectionId: string, credentialValues: Record<string, string>) =>
    api.post<ToolConnectionHealthCheckResult>(`/tool-connections/${connectionId}/reconnect`, {
      credentialValues,
    }),
  refreshCatalog: (connectionId: string) =>
    api.post<ToolCatalogRefreshResult>(`/tool-connections/${connectionId}/catalog/refresh`, {}),

  // --- Grants / installations (Connections v3 P2, PAP-14830) ---
  // Grants are the layer between a connection (config) and credential material:
  // workspace grants = provider-tenant installations; user grants = per-user OAuth.
  // The route returns a wrapper (`{ connection, grants }`), not a bare array, so
  // we unwrap `.grants` here. Fall back gracefully if the server ever returns a
  // bare array or an unexpected shape, to keep the Grants tab from hard-crashing
  // on `grants.filter is not a function`. See PAP-14922.
  listConnectionGrants: async (connectionId: string): Promise<ConnectionGrant[]> => {
    const res = await api.get<ConnectionGrantsResponse | ConnectionGrant[]>(
      `/tool-connections/${connectionId}/grants`,
    );
    if (Array.isArray(res)) return res;
    return Array.isArray(res?.grants) ? res.grants : [];
  },
  addConnectionInstallation: (
    connectionId: string,
    input: {
      providerTenant?: { name?: string; externalId?: string };
      credentialSecretRefs?: ToolCredentialSecretRef[];
      isDefault?: boolean;
    },
  ) =>
    api.post<ConnectionGrant>(`/tool-connections/${connectionId}/grants/installations`, input),
  revokeConnectionGrant: (connectionId: string, grantId: string) =>
    api.delete<ConnectionGrant>(`/tool-connections/${connectionId}/grants/${grantId}`),

  // --- Usage observability (P2/WS3, PAP-14830) ---
  getConnectionUsage: (connectionId: string, range: "7d" | "30d" = "7d") =>
    api.get<ConnectionUsageResponse>(
      `/tool-connections/${connectionId}/usage?range=${range}`,
    ),

  // --- app-initiated user consent (startAuthorization, P2) ---
  // Board users may authorize their own subject; returns the provider consent URL.
  startConnectionAuthorization: (
    companyId: string,
    connectionId: string,
    input: StartConnectionAuthorizationRequest,
  ) =>
    api.post<StartConnectionAuthorizationResponse>(
      `/companies/${companyId}/tools/connections/${connectionId}/start-authorization`,
      input,
    ),
  listCatalog: (connectionId: string) =>
    api.get<ToolCatalogResponse>(`/tool-connections/${connectionId}/catalog`),
  listConnectionActivity: (connectionId: string, limit = 20) =>
    api.get<ToolConnectionActivityResponse>(
      `/tool-connections/${connectionId}/activity?limit=${limit}`,
    ),
  // --- Triggers (Connections v3, PAP-14832 P6c): inbound webhook routes ---
  listConnectionTriggers: (connectionId: string) =>
    api.get<ConnectionTriggersResponse>(`/tool-connections/${connectionId}/triggers`),
  createConnectionTrigger: (connectionId: string, input: CreateConnectionTrigger) =>
    api.post<ConnectionTriggerRecord>(`/tool-connections/${connectionId}/triggers`, input),
  updateConnectionTrigger: (connectionId: string, triggerId: string, input: UpdateConnectionTrigger) =>
    api.patch<ConnectionTriggerRecord>(`/tool-connections/${connectionId}/triggers/${triggerId}`, input),
  deleteConnectionTrigger: (connectionId: string, triggerId: string) =>
    api.delete<void>(`/tool-connections/${connectionId}/triggers/${triggerId}`),
  getConnectionTriggerDeliveries: (connectionId: string) =>
    api.get<ConnectionTriggerDeliveriesResponse>(`/tool-connections/${connectionId}/deliveries`),
  listTestAgents: (connectionId: string) =>
    api.get<ToolConnectionTestAgentsResponse>(
      `/tool-connections/${connectionId}/test-agents`,
    ),
  runTestCall: (
    connectionId: string,
    input: { agentId: string; toolName: string; parameters?: Record<string, unknown> },
  ) =>
    api.post<ToolConnectionTestCallResult>(
      `/tool-connections/${connectionId}/test-calls`,
      input,
    ),
  getTestCallStatus: (connectionId: string, actionRequestId: string) =>
    api.get<ToolConnectionTestCallStatus>(
      `/tool-connections/${connectionId}/test-calls/${actionRequestId}`,
    ),
  importMcpJson: (companyId: string, body: { mcpJson: unknown }) =>
    api.post<McpJsonImportPreview>(`/companies/${companyId}/tools/mcp/import-json`, body),
  listStdioTemplates: (companyId: string) =>
    api.get<StdioTemplatesResponse>(`/companies/${companyId}/tools/stdio-templates`),
  createStdioTemplate: (companyId: string, input: CreateStdioTemplateInput) =>
    api.post<StdioTemplateSummary>(`/companies/${companyId}/tools/stdio-templates`, input),
  disableStdioTemplate: (companyId: string, templateId: string, reason?: string | null) =>
    api.post<StdioTemplateSummary>(
      `/companies/${companyId}/tools/stdio-templates/${encodeURIComponent(templateId)}/disable`,
      { reason: reason ?? null },
    ),

  // --- Profiles ---
  listProfiles: (companyId: string) =>
    api.get<ToolProfilesResponse>(`/companies/${companyId}/tools/profiles`),
  getProfileNewTools: (profileId: string) =>
    api.get<ToolProfileNewToolsReview>(`/tool-profiles/${profileId}/new-tools`),
  reviewProfileNewTools: (profileId: string, input: ReviewNewToolsInput) =>
    api.post<ToolProfileNewToolsReviewResult>(`/tool-profiles/${profileId}/new-tools/review`, input),
  createProfile: (companyId: string, input: CreateToolProfileInput) =>
    api.post<ToolProfileWithDetails>(`/companies/${companyId}/tools/profiles`, input),
  updateProfile: (profileId: string, input: UpdateToolProfileInput) =>
    api.patch<ToolProfileWithDetails>(`/tool-profiles/${profileId}`, input),
  duplicateProfile: (
    profileId: string,
    input: { name: string; includeAssignments?: boolean },
  ) => api.post<ToolProfileWithDetails>(`/tool-profiles/${profileId}/duplicate`, input),
  deleteProfile: (
    profileId: string,
    input: { force?: boolean; reassignToProfileId?: string } = {},
  ) => api.delete<{ deleted: true }>(`/tool-profiles/${profileId}`, input),
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
  reorderPolicies: (companyId: string, input: ReorderToolPolicies) =>
    api.post<ToolPoliciesResponse>(`/companies/${companyId}/tools/policies/reorder`, input),
  duplicatePolicy: (companyId: string, policyId: string, input: DuplicateToolPolicy = {}) =>
    api.post<ToolPolicy>(`/companies/${companyId}/tools/policies/${policyId}/duplicate`, input),
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

  // --- Review queue (Ask first) ---
  listActionRequests: (companyId: string, status: ToolActionRequestStatus = "pending") =>
    api.get<ToolActionRequestsResponse>(
      `/companies/${companyId}/tools/action-requests?status=${encodeURIComponent(status)}`,
    ),
  approveActionRequest: (companyId: string, actionRequestId: string) =>
    api.post<ToolActionRequest>(`/tool-gateway/action-requests/${actionRequestId}/approve`, { companyId }),
  declineActionRequest: (companyId: string, actionRequestId: string) =>
    api.post<ToolActionRequest>(`/tool-gateway/action-requests/${actionRequestId}/decline`, { companyId }),
  createTrustRuleFromActionRequest: (
    companyId: string,
    actionRequestId: string,
    input: CreateToolTrustRuleFromActionRequest = {},
  ) =>
    api.post<ToolPolicy>(
      `/companies/${companyId}/tools/action-requests/${actionRequestId}/trust-rule`,
      input,
    ),

  // --- Named MCP gateways ---
  listGateways: (companyId: string) =>
    api.get<ToolMcpGatewaysResponse>(`/companies/${companyId}/tools/gateways`),
  createGateway: (companyId: string, input: CreateToolMcpGateway) =>
    api.post<ToolMcpGatewayWithTokens>(`/companies/${companyId}/tools/gateways`, input),
  updateGateway: (companyId: string, gatewayId: string, input: UpdateGatewayInput) =>
    api.patch<ToolMcpGatewayWithTokens>(`/tool-gateway/gateways/${gatewayId}`, { ...input, companyId }),
  createGatewayToken: (companyId: string, gatewayId: string, input: CreateGatewayTokenInput) =>
    api.post<ToolMcpGatewayTokenCreated>(`/tool-gateway/gateways/${gatewayId}/tokens`, { ...input, companyId }),
  revokeGatewayToken: (companyId: string, tokenId: string) =>
    api.post<ToolMcpGatewayToken>(`/tool-gateway/gateway-tokens/${tokenId}/revoke`, { companyId }),

  // --- Audit / Activity ---
  /**
   * Humanized Activity feed with server-side filters and cursor pagination.
   * Returns `{ events, nextCursor }`.
   */
  listActivity: (companyId: string, params: ListActivityParams = {}) => {
    const search = new URLSearchParams({ companyId });
    if (params.app) search.set("app", params.app);
    if (params.agent) search.set("agent", params.agent);
    if (params.outcome) search.set("outcome", params.outcome);
    if (params.window) search.set("window", params.window);
    if (params.search) search.set("search", params.search);
    if (params.cursor) search.set("cursor", params.cursor);
    search.set("limit", String(params.limit ?? 50));
    return api.get<ToolGatewayActivityResponse>(`/tool-gateway/audit?${search.toString()}`);
  },
  /** Flat audit sample (no pagination) — used by derived counters/banners. */
  listAudit: (companyId: string, limit = 100) =>
    api
      .get<ToolGatewayActivityResponse>(
        `/tool-gateway/audit?companyId=${encodeURIComponent(companyId)}&window=30d&limit=${Math.min(limit, 100)}`,
      )
      .then((res) => res.events),
};
