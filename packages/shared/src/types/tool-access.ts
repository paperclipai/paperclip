import type {
  ToolActionRequestStatus,
  ToolApplicationStatus,
  ToolApplicationType,
  ToolAuditEventType,
  ToolAuditOutcome,
  ToolCatalogEntryKind,
  ToolCatalogEntryStatus,
  ToolConnectionHealthStatus,
  ToolConnectionKind,
  ToolConnectionLifecycleEventType,
  ToolInvocationApprovalState,
  ToolInvocationStatus,
  ToolMcpGatewayContextScopeType,
  ToolMcpGatewayDefaultProfileMode,
  ToolMcpGatewayStatus,
  ToolMcpGatewayTokenAction,
  ToolMcpGatewayTokenSubjectType,
  ToolPolicyDecision,
  ToolPolicyType,
  ToolProfileBindingTargetType,
  ToolProfileDefaultAction,
  ToolProfileEntryEffect,
  ToolProfileEntrySelectorType,
  ToolProfileStatus,
  ToolRateLimitWindowKind,
  ToolRiskLevel,
  ToolRuntimeKind,
  ToolRuntimeSlotStatus,
} from "../constants.js";

export type {
  ToolActionRequestStatus,
  ToolApplicationStatus,
  ToolApplicationType,
  ToolAuditEventType,
  ToolAuditOutcome,
  ToolCatalogEntryKind,
  ToolCatalogEntryStatus,
  ToolConnectionHealthStatus,
  ToolConnectionKind,
  ToolConnectionLifecycleEventType,
  ToolInvocationApprovalState,
  ToolInvocationStatus,
  ToolMcpGatewayContextScopeType,
  ToolMcpGatewayDefaultProfileMode,
  ToolMcpGatewayStatus,
  ToolMcpGatewayTokenAction,
  ToolMcpGatewayTokenSubjectType,
  ToolPolicyDecision,
  ToolPolicyType,
  ToolProfileBindingTargetType,
  ToolProfileDefaultAction,
  ToolProfileEntryEffect,
  ToolProfileEntrySelectorType,
  ToolProfileStatus,
  ToolRateLimitWindowKind,
  ToolRiskLevel,
  ToolRuntimeKind,
  ToolRuntimeSlotStatus,
};

export type ToolActorType = "agent" | "user" | "system" | "plugin";
export type ToolConnectionTransport = "remote_http" | "local_stdio";
export type ToolConnectionStatus = "draft" | "active" | "disabled" | "archived";
export type ToolCredentialPlacement = "header" | "env";

export interface McpConnectionCredentialRef {
  name: string;
  secretId: string;
  version?: number | "latest";
  placement: ToolCredentialPlacement;
  key: string;
  prefix?: string | null;
}

export interface ToolCredentialSecretRef {
  secretId: string;
  versionSelector?: number | "latest";
  configPath: string;
  required?: boolean;
  label?: string | null;
}

export interface ToolRedactedValueSummary {
  summary: string;
  sizeBytes?: number | null;
  sha256?: string | null;
  redactedFields?: string[];
  artifactId?: string | null;
}

export interface ToolApplication {
  id: string;
  companyId: string;
  applicationKey?: string;
  name: string;
  description: string | null;
  type: ToolApplicationType;
  status: ToolApplicationStatus;
  pluginId: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  metadata: Record<string, unknown> | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolConnection {
  id: string;
  companyId: string;
  applicationId: string;
  name: string;
  connectionKind: ToolConnectionKind;
  transport?: ToolConnectionTransport;
  status?: ToolConnectionStatus;
  transportConfig: Record<string, unknown>;
  config?: Record<string, unknown>;
  credentialSecretRefs: ToolCredentialSecretRef[];
  credentialRefs?: McpConnectionCredentialRef[];
  healthStatus: ToolConnectionHealthStatus;
  healthMessage?: string | null;
  healthCheckedAt: Date | null;
  lastHealthAt?: Date | string | null;
  lastCatalogRefreshAt?: Date | string | null;
  lastError: string | null;
  /** Most recent tool-call event timestamp for this connection; only populated by list endpoints. */
  lastUsedAt?: Date | string | null;
  enabled: boolean;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolCatalogEntry {
  id: string;
  companyId: string;
  applicationId: string | null;
  connectionId: string;
  entryKind: ToolCatalogEntryKind;
  name?: string;
  toolName: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  riskLevel: ToolRiskLevel;
  isReadOnly: boolean;
  isWrite: boolean;
  isDestructive: boolean;
  status: ToolCatalogEntryStatus;
  addedAt: Date;
  version: string | null;
  versionHash?: string | null;
  schemaHash: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  reviewedAt: Date | null;
  reviewedByAgentId: string | null;
  reviewedByUserId: string | null;
  quarantinedAt?: Date | string | null;
  quarantineReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolProfile {
  id: string;
  companyId: string;
  profileKey: string;
  name: string;
  description: string | null;
  status: ToolProfileStatus;
  defaultAction: ToolProfileDefaultAction;
  newToolsReviewedAt: Date | null;
  newToolsPendingCount?: number;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolProfileEntry {
  id: string;
  companyId: string;
  profileId: string;
  selectorType: ToolProfileEntrySelectorType;
  effect: ToolProfileEntryEffect;
  applicationId: string | null;
  connectionId: string | null;
  catalogEntryId: string | null;
  toolName: string | null;
  riskLevel: ToolRiskLevel | null;
  conditions: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolProfileBinding {
  id: string;
  companyId: string;
  profileId: string;
  targetType: ToolProfileBindingTargetType;
  targetId: string;
  priority: number;
  metadata: Record<string, unknown> | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolMcpGatewayBearerAuthConfig {
  enabled: boolean;
  tokenPrefix: "pcgw";
  defaultTtlSeconds: number | null;
  requireFiniteExpiry: boolean;
  longLivedTokenRequiresOverride: boolean;
}

export interface ToolMcpGatewayOAuthReservedConfig {
  enabled: false;
  reservedFor: "v1_5";
  protectedResourceMetadataPath?: string | null;
  dynamicClientRegistration?: false;
  authorizationCodePkce?: false;
}

export interface ToolMcpGatewayAuthConfig {
  version: 1;
  bearer: ToolMcpGatewayBearerAuthConfig;
  oauth: ToolMcpGatewayOAuthReservedConfig;
}

export interface ToolMcpGatewayStaticHeaderPolicy {
  name: string;
  valueRef?: string | null;
  value?: string | null;
}

export interface ToolMcpGatewayCallerHeaderPolicy {
  enabled: boolean;
  allowedHeaders: string[];
}

export interface ToolMcpGatewayGeneratedMetadataHeaderPolicy {
  enabled: boolean;
  allowedHeaders: string[];
}

export interface ToolMcpGatewayResponseHeaderPolicy {
  forwardMcpRequiredHeaders: boolean;
  forwardSafeCacheHeaders: boolean;
}

export interface ToolMcpGatewayHeaderPolicy {
  version: 1;
  callerPassthrough: ToolMcpGatewayCallerHeaderPolicy;
  staticHeaders: ToolMcpGatewayStaticHeaderPolicy[];
  generatedMetadata: ToolMcpGatewayGeneratedMetadataHeaderPolicy;
  responseHeaders: ToolMcpGatewayResponseHeaderPolicy;
}

export interface ToolMcpGatewayMetadataPolicy {
  version: 1;
  forwardCompanyId: boolean;
  forwardGatewayId: boolean;
  forwardProjectId: boolean;
  forwardIssueId: boolean;
  forwardAgentId: boolean;
  forwardRunId: boolean;
  forwardCorrelationId: boolean;
}

export interface ToolMcpGatewayOnDemandToolsConfig {
  enabled: boolean;
  searchToolName: "search_tools";
  runToolName: "run_tool";
}

export interface ToolMcpGateway {
  id: string;
  companyId: string;
  gatewayPublicId: string;
  name: string;
  displaySlug: string;
  /** @deprecated Use displaySlug for UI labels and gatewayPublicId for protocol URLs. */
  slug: string;
  description: string | null;
  status: ToolMcpGatewayStatus;
  profileId: string;
  defaultProfileMode: ToolMcpGatewayDefaultProfileMode;
  contextScopeType: ToolMcpGatewayContextScopeType;
  contextScopeId: string | null;
  agentId: string | null;
  projectId: string | null;
  issueId: string | null;
  approvalIssueId: string | null;
  endpointPath: string;
  authConfig: ToolMcpGatewayAuthConfig;
  headerPolicy: ToolMcpGatewayHeaderPolicy;
  metadataPolicy: ToolMcpGatewayMetadataPolicy;
  onDemandToolsConfig: ToolMcpGatewayOnDemandToolsConfig;
  metadata: Record<string, unknown> | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolMcpGatewayToken {
  id: string;
  companyId: string;
  gatewayId: string;
  name: string;
  tokenPrefix: string;
  subjectType: ToolMcpGatewayTokenSubjectType;
  subjectId: string | null;
  clientLabel: string;
  ownerNote: string;
  allowedActions: ToolMcpGatewayTokenAction[];
  expiresAt: Date | string | null;
  expiryOverrideReason: string | null;
  expiryOverrideByUserId: string | null;
  expiryOverrideByAgentId: string | null;
  expiryOverrideAt: Date | string | null;
  lastUsedAt: Date | string | null;
  revokedAt: Date | string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ToolMcpGatewayTokenCreated extends ToolMcpGatewayToken {
  token: string;
}

export interface ToolMcpGatewayClientSnippet {
  client: "cursor" | "claude_desktop" | "vscode" | "claude_code" | "opencode";
  label: string;
  config: Record<string, unknown>;
  notes: string[];
}

export interface ToolMcpGatewayWithTokens extends ToolMcpGateway {
  tokens: ToolMcpGatewayToken[];
  clientSnippets: ToolMcpGatewayClientSnippet[];
}

export interface ToolProfileSummary {
  accessMode: "selected" | "all_except";
  allowedToolCount: number;
  allowedApplicationCount: number;
  excludedToolCount: number;
  totalToolCount: number;
  assignmentCount: number;
  appliesToAgentCount: number;
  isCompanyDefault: boolean;
}

export interface ToolProfileWithDetails extends ToolProfile {
  entries: ToolProfileEntry[];
  bindings: ToolProfileBinding[];
  summary: ToolProfileSummary;
}

export type ToolProfileNewToolReviewDecision = "allow" | "keep_blocked";

export interface ToolProfileNewToolReviewItem {
  catalogEntryId: string;
  applicationId: string | null;
  applicationName: string | null;
  connectionId: string;
  connectionName: string | null;
  toolName: string;
  title: string | null;
  description: string | null;
  capability: ToolRiskLevel;
  riskLevel: ToolRiskLevel;
  addedAt: Date;
  firstSeenAt: Date;
}

export interface ToolProfileNewToolsReview {
  profileId: string;
  reviewedAt: Date | null;
  pendingCount: number;
  tools: ToolProfileNewToolReviewItem[];
}

export interface ToolProfileNewToolsReviewResult {
  profile: ToolProfileWithDetails;
  reviewedAt: Date;
  allowedCount: number;
  keptBlockedCount: number;
  entriesCreated: ToolProfileEntry[];
  reviewedCatalogEntryIds: string[];
}

export interface ToolProfileEffectiveSummary {
  agentId: string;
  profiles: ToolProfileWithDetails[];
  entries: ToolProfileEntry[];
  bindings: ToolProfileBinding[];
  allowedTools: ToolCatalogEntry[];
  allowedToolNames: string[];
}

export interface ToolPolicy {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  policyType: ToolPolicyType;
  priority: number;
  enabled: boolean;
  selectors: Record<string, unknown>;
  conditions: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolRuntimeSlot {
  id: string;
  companyId: string;
  applicationId: string | null;
  connectionId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  issueId: string | null;
  ownerScopeType: string;
  ownerScopeId: string | null;
  runtimeKind: ToolRuntimeKind;
  slotKey?: string;
  status: ToolRuntimeSlotStatus;
  reuseKey: string | null;
  workspaceScope: string | null;
  credentialScopeHash: string | null;
  provider: string | null;
  providerRef: string | null;
  processId: number | null;
  commandTemplateKey: string | null;
  healthStatus: string | null;
  healthMessage?: string | null;
  lastHealthCheckAt: Date | null;
  lastStartedAt?: Date | string | null;
  idleExpiresAt: Date | null;
  idleDeadlineAt?: Date | string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  lastUsedAt: Date | null;
  lastError: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolStdioTemplateToolSummary {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
  annotations?: Record<string, unknown> | null;
}

export interface ToolStdioCommandTemplate {
  id?: string;
  companyId?: string;
  templateId: string;
  name: string;
  title?: string | null;
  description?: string | null;
  status: "active" | "disabled";
  source: "built_in" | "admin";
  command?: string | null;
  args: string[];
  envKeys: string[];
  tools: ToolStdioTemplateToolSummary[];
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  disabledAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export type ToolRuntimeAlertSeverity = "info" | "warning" | "critical";
export type ToolRuntimeAlertStatus = "ok" | "firing" | "not_instrumented";

export interface ToolRuntimeAlertRecommendation {
  name: string;
  severity: ToolRuntimeAlertSeverity;
  status: ToolRuntimeAlertStatus;
  threshold: string;
  observed: string;
  description: string;
  firstResponderAction: string;
  runbookSection: string;
}

export interface ToolRuntimeMetricSnapshot {
  windowStartedAt: Date | string;
  windowEndedAt: Date | string;
  activeSlots: number;
  startingSlots: number;
  runningSlots: number;
  idleSlots: number;
  failedSlots: number;
  stoppedSlots: number;
  stuckStartingSlots: number;
  stuckRunningSlots: number;
  capacityDeferralsLastHour: number;
  restartAttemptsLastHour: number;
  restartSuppressionsLastHour: number;
  idleEvictionsLastHour: number;
  toolCallsLastHour: number;
  toolTimeoutsLastHour: number;
  toolFailuresLastHour: number;
  timeoutRateLastHour: number;
  failureRateLastHour: number;
  averageToolLatencyMsLastHour: number | null;
  p95ToolLatencyMsLastHour: number | null;
  missingSecretFailuresLastHour: number;
  auditWriteFailuresLastHour: number | null;
  activeConnections: number;
  disabledConnections: number;
  degradedConnections: number;
  remoteHttpConnections: number;
  localStdioConnections: number;
}

export interface ToolRuntimeSupportMatrix {
  remoteHttp: {
    supported: boolean;
    note: string;
  };
  localStdio: {
    supported: boolean;
    note: string;
  };
}

export interface ToolRuntimeHealthSummary {
  status: "ok" | "degraded" | "critical";
  generatedAt: Date | string;
  runbookPath: string;
  metrics: ToolRuntimeMetricSnapshot;
  supportMatrix: ToolRuntimeSupportMatrix;
  alerts: ToolRuntimeAlertRecommendation[];
  recommendations: ToolRuntimeAlertRecommendation[];
}

export interface ToolConnectionHealthCheckResult {
  connection: ToolConnection;
  runtimeSlot: ToolRuntimeSlot | null;
}

export interface ToolCatalogRefreshResult {
  connection: ToolConnection;
  catalog: ToolCatalogEntry[];
  discoveredCount: number;
  quarantinedCount: number;
}

export type ToolAppAttentionReason =
  | "health"
  | "quarantined_catalog_entries"
  | "pending_action_requests"
  | "profile_new_tools";

export interface ToolAppAttentionProfileNewTools {
  profileId: string;
  profileName: string;
  pendingCount: number;
}

export interface ToolAppAttentionItem {
  connection: ToolConnection;
  healthNeedsAttention: boolean;
  quarantinedCatalogEntryCount: number;
  pendingActionRequestCount: number;
  newToolsPendingReviewCount: number;
  newToolsPendingProfiles: ToolAppAttentionProfileNewTools[];
  reasons: ToolAppAttentionReason[];
}

export interface ToolAppsAttentionResponse {
  generatedAt: Date | string;
  apps: ToolAppAttentionItem[];
  totals: {
    connections: number;
    health: number;
    quarantinedCatalogEntries: number;
    pendingActionRequests: number;
    newToolsPendingReview: number;
    newToolsPendingProfiles: number;
  };
}

/**
 * A connection-level lifecycle event (install, pause/resume, allowlist change,
 * reconnect/disconnect, new-actions quarantine) surfaced on the per-app
 * Activity tab alongside tool-call events (PAP-11284). Derived from the
 * company activity log rows scoped to a single tool connection.
 */
export interface ToolConnectionLifecycleEvent {
  id: string;
  connectionId: string;
  type: ToolConnectionLifecycleEventType;
  actorType: ToolActorType;
  /** Raw actor id (user id, agent id, or "board"/"system"); use actorDisplayName for rendering. */
  actorId: string | null;
  agentId: string | null;
  /** Server-resolved display name for the actor (agent name or user name/email), null when unknown. */
  actorDisplayName: string | null;
  /** Event-specific structured detail, e.g. `{ added, removed }` for allowlist or `{ count }` for quarantine. */
  details: Record<string, unknown> | null;
  createdAt: Date;
}

/** Recent tool-call and lifecycle events for a single app connection (App detail · Recent activity). */
export interface ToolConnectionActivityResponse {
  connectionId: string;
  events: ToolCallEvent[];
  lifecycleEvents: ToolConnectionLifecycleEvent[];
  issues: Record<string, {
    identifier: string;
    title: string;
  }>;
  actionRequests: Record<string, {
    status: ToolActionRequestStatus;
    resolverDisplayName: string | null;
    resolvedByAgentId: string | null;
    resolvedByUserId: string | null;
  }>;
}

/**
 * A pending (or recently resolved) "Ask first" request, enriched with the
 * connection/app context the review-queue card needs to render a prosumer
 * sentence without extra round-trips.
 */
export interface ToolActionRequestListItem {
  request: ToolActionRequest;
  toolName: string;
  toolTitle: string | null;
  connectionId: string | null;
  connectionName: string | null;
  applicationName: string | null;
  riskLevel: ToolRiskLevel | null;
  requestedByAgentId: string | null;
}

export interface ToolActionRequestsResponse {
  actionRequests: ToolActionRequestListItem[];
}

export interface ToolExampleSummary {
  id: string;
  title: string;
  description: string;
  fixture: {
    transport: ToolConnectionTransport;
    templateId: string;
    available: boolean;
    tools: Array<{
      name: string;
      description?: string | null;
      riskLevel: ToolRiskLevel;
      readOnly: boolean;
    }>;
  };
  safeDefaultProfile: {
    profileKey: string;
    name: string;
    defaultAction: ToolProfileDefaultAction;
    allowedToolNames: string[];
  };
  install: {
    installed: boolean;
    canInstall: boolean;
    reason?: string | null;
    applicationId?: string | null;
    connectionId?: string | null;
    profileId?: string | null;
    profileBindingId?: string | null;
  };
}

export interface ToolExampleInstallResult {
  example: ToolExampleSummary;
  created: boolean;
  application: ToolApplication;
  connection: ToolConnection;
  profile: ToolProfile;
  profileEntries: ToolProfileEntry[];
  profileBinding: ToolProfileBinding;
  catalog: ToolCatalogEntry[];
}

export interface ToolExampleSmokeCheck {
  name: string;
  ok: boolean;
  toolName?: string | null;
  expectedDecision?: ToolPolicyDecision | null;
  decision?: ToolPolicyDecision | null;
  reasonCode?: ToolAccessReasonCode | string | null;
  explanation?: string | null;
  auditEventId?: string | null;
  toolCallEventId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface ToolExampleSmokeResult {
  exampleId: string;
  ok: boolean;
  actor: {
    actorType: ToolActorType;
    actorId: string;
    agentId?: string | null;
  };
  connection: ToolConnection;
  profile: ToolProfile;
  checks: ToolExampleSmokeCheck[];
}

export interface ToolAppConnectionActionSummary {
  catalogEntryId: string;
  toolName: string;
  title: string | null;
  description: string | null;
  riskLevel: ToolRiskLevel;
  isReadOnly: boolean;
  isWrite: boolean;
  isDestructive: boolean;
  status: ToolCatalogEntryStatus;
}

export interface ConnectToolAppResult {
  connectionId: string;
  application: ToolApplication;
  connection: ToolConnection;
  catalog: ToolCatalogEntry[];
  actions: {
    readOnly: ToolAppConnectionActionSummary[];
    canMakeChanges: ToolAppConnectionActionSummary[];
  };
  suggestedDefaults: Record<string, unknown>;
  auth?: {
    kind: "oauth";
    startUrl: string | null;
  } | null;
}

export interface ToolOAuthStartResult {
  connectionId: string;
  provider: string;
  authorizationUrl: string;
  expiresAt: string;
}

export interface FinishToolAppResult {
  connection: ToolConnection;
  profile: ToolProfile;
  profileEntries: ToolProfileEntry[];
  profileBindings: ToolProfileBinding[];
  policies: ToolPolicy[];
}

export interface McpJsonImportDraft {
  name: string;
  transport: ToolConnectionTransport;
  status: ToolConnectionStatus;
  config: Record<string, unknown>;
  credentialRefs: McpConnectionCredentialRef[];
  credentialFields: Array<{
    configPath: string;
    label: string;
    placement: ToolCredentialPlacement;
    key: string;
    prefix: string | null;
    required: boolean;
  }>;
  warnings: string[];
}

export interface McpJsonImportPreview {
  drafts: McpJsonImportDraft[];
}

export interface ToolInvocation {
  id: string;
  companyId: string;
  idempotencyKey: string | null;
  actorType: ToolActorType;
  actorId: string | null;
  agentId: string | null;
  issueId: string | null;
  runId: string | null;
  applicationId: string | null;
  connectionId: string | null;
  catalogEntryId: string | null;
  toolName: string;
  argumentsHash: string | null;
  argumentsSummary: ToolRedactedValueSummary | null;
  policyDecision: ToolPolicyDecision | null;
  matchedPolicyIds: string[];
  approvalState: ToolInvocationApprovalState;
  status: ToolInvocationStatus;
  upstreamRequestId: string | null;
  resultHash: string | null;
  resultSummary: ToolRedactedValueSummary | null;
  resultSizeBytes: number | null;
  resultArtifactId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolActionRequest {
  id: string;
  companyId: string;
  invocationId: string;
  issueId: string | null;
  interactionId: string | null;
  approvalId: string | null;
  status: ToolActionRequestStatus;
  canonicalArgumentsHash: string;
  canonicalArgumentsSummary: ToolRedactedValueSummary;
  signedArguments: string | null;
  previewMarkdown: string | null;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  resolvedByAgentId: string | null;
  resolvedByUserId: string | null;
  decidedByAgentId?: string | null;
  decidedByUserId?: string | null;
  decidedAt?: Date | null;
  expiresAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolCallEvent {
  id: string;
  companyId: string;
  eventType: ToolAuditEventType;
  actorType: ToolActorType;
  actorId: string | null;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
  applicationId: string | null;
  connectionId: string | null;
  catalogEntryId: string | null;
  invocationId: string | null;
  actionRequestId: string | null;
  runtimeSlotId: string | null;
  toolName: string | null;
  decision: ToolPolicyDecision | null;
  matchedPolicyIds: string[];
  reasonCode: string | null;
  outcome: ToolAuditOutcome;
  latencyMs: number | null;
  argumentsSummary?: ToolRedactedValueSummary | null;
  requestHash: string | null;
  requestSummary: ToolRedactedValueSummary | null;
  resultHash: string | null;
  resultSummary: ToolRedactedValueSummary | null;
  resultSizeBytes: number | null;
  redactionPlan: Record<string, unknown> | null;
  rateLimitState: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface ToolRunDecision {
  invocation: ToolInvocation;
  actionRequest: ToolActionRequest | null;
  auditEvents: ToolCallEvent[];
  latestAuditEvent: ToolCallEvent | null;
  decision: ToolPolicyDecision | null;
  outcome: ToolAuditOutcome | null;
  reasonCode: string | null;
  denialReason: string | null;
  pendingAction: {
    actionRequestId: string;
    issueId: string | null;
    interactionId: string | null;
    approvalId: string | null;
    status: ToolActionRequestStatus;
    previewMarkdown: string | null;
  } | null;
}

export interface ToolRunDecisionLookup {
  runId: string;
  decisions: ToolRunDecision[];
}

export interface ToolRateLimitCounter {
  id: string;
  companyId: string;
  policyId: string | null;
  counterKey: string;
  scopeType: string;
  scopeId: string;
  windowKind: ToolRateLimitWindowKind;
  windowStartAt: Date;
  limit: number;
  remaining: number;
  resetAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ToolAccessReasonCode =
  | "allow_trust_rule"
  | "allow_profile"
  | "allow_explicit_grant"
  | "allow_policy"
  | "requires_review_changed_tool"
  | "requires_approval_policy"
  | "deny_default"
  | "deny_company_boundary"
  | "deny_disabled_connection"
  | "deny_disabled_application"
  | "deny_archived_application"
  | "deny_missing_tool"
  | "deny_policy_block"
  | "deny_run_context_mismatch"
  | "deny_missing_agent"
  | "rate_limited";

export interface ToolAccessSelector {
  actorType?: ToolActorType;
  actorTypes?: ToolActorType[];
  agentId?: string;
  agentIds?: string[];
  projectId?: string;
  projectIds?: string[];
  routineId?: string;
  routineIds?: string[];
  issueId?: string;
  issueIds?: string[];
  gatewayId?: string;
  gatewayIds?: string[];
  gatewayPublicId?: string;
  gatewayPublicIds?: string[];
  gatewayTokenId?: string;
  gatewayTokenIds?: string[];
  clientSubjectType?: ToolMcpGatewayTokenSubjectType;
  clientSubjectTypes?: ToolMcpGatewayTokenSubjectType[];
  clientName?: string;
  clientNames?: string[];
  externalClient?: boolean;
  applicationId?: string;
  applicationIds?: string[];
  connectionId?: string;
  connectionIds?: string[];
  catalogEntryId?: string;
  catalogEntryIds?: string[];
  toolName?: string;
  toolNames?: string[];
  riskLevel?: ToolRiskLevel;
  riskLevels?: ToolRiskLevel[];
}

export interface ToolRateLimitRule {
  limit: number;
  windowSeconds: number;
  keyBy?: Array<"company" | "agent" | "application" | "connection" | "tool">;
}

export interface ToolTrustRuleArgumentFilters {
  allowAny?: boolean;
  exactHash?: string | null;
  allowedHashes?: string[];
  fieldEquals?: Record<string, unknown>;
  fieldNotEquals?: Record<string, unknown>;
  fieldIn?: Record<string, unknown[]>;
  fieldMatches?: Record<string, string>;
  fieldExists?: string[];
  fieldAbsent?: string[];
}

export interface ToolPolicyConditions {
  arguments?: {
    fieldEquals?: Record<string, unknown>;
    fieldNotEquals?: Record<string, unknown>;
    fieldIn?: Record<string, unknown[]>;
    fieldMatches?: Record<string, string>;
    fieldExists?: string[];
    fieldAbsent?: string[];
  };
  args?: ToolPolicyConditions["arguments"];
  actor?: ToolAccessSelector;
  context?: ToolAccessSelector & {
    requireIssue?: boolean;
    requireProject?: boolean;
    requireRoutine?: boolean;
  };
  risk?: {
    levels?: ToolRiskLevel[];
    max?: ToolRiskLevel;
    isWrite?: boolean;
    isDestructive?: boolean;
  };
  credentialScope?: Pick<ToolAccessSelector, "applicationId" | "applicationIds" | "connectionId" | "connectionIds" | "catalogEntryId" | "catalogEntryIds"> & {
    applicationKey?: string;
    applicationKeys?: string[];
    providerType?: string;
    providerTypes?: string[];
  };
  trustBoundary?: {
    providerType?: string;
    providerTypes?: string[];
    applicationKey?: string;
    applicationKeys?: string[];
    remoteHttpOnly?: boolean;
    paperclipSelfOnly?: boolean;
  };
  timeWindow?: {
    startAt?: string;
    endAt?: string;
    daysOfWeekUtc?: number[];
    startHourUtc?: number;
    endHourUtc?: number;
  };
}

export interface ToolTrustRuleScopeInput {
  includeAgent?: boolean;
  includeProject?: boolean;
  includeIssue?: boolean;
  includeApplication?: boolean;
  includeConnection?: boolean;
  includeCatalogEntry?: boolean;
  includeTool?: boolean;
}

export interface ToolTrustRuleBatchApprovalConfig {
  enabled?: boolean;
  maxBatchSize?: number;
  windowSeconds?: number;
}

export interface CreateToolTrustRuleFromActionRequest {
  name?: string;
  description?: string | null;
  priority?: number;
  approvalThreshold?: number;
  selectors?: ToolAccessSelector;
  scope?: ToolTrustRuleScopeInput;
  argumentFilters?: ToolTrustRuleArgumentFilters;
  expiresAt?: Date | string | null;
  batchApproval?: ToolTrustRuleBatchApprovalConfig | null;
}

export interface RevokeToolTrustRule {
  reason?: string | null;
}

export interface ToolAccessDecisionInput {
  companyId: string;
  actor: {
    actorType: ToolActorType;
    actorId: string;
    agentId?: string | null;
    userId?: string | null;
  };
  runContext?: {
    heartbeatRunId?: string | null;
    issueId?: string | null;
    projectId?: string | null;
    routineId?: string | null;
    gatewayId?: string | null;
    gatewayPublicId?: string | null;
    gatewayTokenId?: string | null;
    clientSubjectType?: ToolMcpGatewayTokenSubjectType | null;
    clientSubjectId?: string | null;
    clientName?: string | null;
    externalClient?: boolean | null;
  } | null;
  request: {
    applicationId?: string | null;
    connectionId?: string | null;
    catalogEntryId?: string | null;
    providerType?: string | null;
    applicationKey?: string | null;
    upstreamToolName?: string | null;
    riskLevel?: ToolRiskLevel | string | null;
    toolName: string;
    arguments?: unknown;
    idempotencyKey?: string | null;
    sideEffecting?: boolean;
  };
  consumeRateLimit?: boolean;
  writeAuditEvent?: boolean;
}

export interface ToolAccessDecision {
  decision: ToolPolicyDecision;
  allowed: boolean;
  reasonCode: ToolAccessReasonCode;
  explanation: string;
  effectiveProfileIds: string[];
  matchedPolicyIds: string[];
  redactionPlan?: Record<string, unknown> | null;
  policyExplanation?: Record<string, unknown> | null;
  argumentsSummary?: ToolRedactedValueSummary | null;
  rateLimitState?: Record<string, unknown> | null;
  invocationId?: string | null;
  actionRequestId?: string | null;
}

/**
 * How an action would behave for a given agent if they ran it right now —
 * the same three-way outcome the Test tab and Permissions surface.
 */
export type ToolConnectionTestDecision = "allowed" | "ask_first" | "off";

/** Per-action access summary for one agent on one connection. */
export interface ToolConnectionTestToolAccess {
  /** Upstream tool name; what `test-calls` expects as `toolName`. */
  toolName: string;
  /** Gateway-namespaced tool name (matches the catalog gateway entry). */
  gatewayToolName: string;
  displayName: string | null;
  risk: "read" | "write" | "destructive";
  decision: ToolConnectionTestDecision;
  reasonCode: ToolAccessReasonCode | string | null;
  matchedPolicyIds: string[];
}

/** Roll-up of how every action on a connection behaves for one agent. */
export interface ToolConnectionAccessSummary {
  connectionId: string;
  toolCount: number;
  allowedCount: number;
  askFirstCount: number;
  offCount: number;
  /**
   * When this agent's access to the connection was last reconfigured (ISO
   * timestamp), powering the "Last changed by {Actor} · {relativeTime}" hint in
   * the Test tab Off side panel. Null when no governing config has a timestamp.
   */
  lastChangedAt: string | null;
  /** Agent who made the most recent change, when attributable (policy/binding edits only). */
  lastChangedByAgentId: string | null;
  /** Resolved display name for {@link lastChangedByAgentId}. */
  lastChangedByName: string | null;
  tools: ToolConnectionTestToolAccess[];
}

/** An agent the board member may impersonate in the Test tab. */
export interface ToolConnectionTestAgent {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  effectiveAccess: ToolConnectionAccessSummary;
}

export interface ToolConnectionTestAgentsResponse {
  agents: ToolConnectionTestAgent[];
}

/** Result of `POST /tool-connections/:id/test-calls`. */
export interface ToolConnectionTestCallResult {
  decision: ToolConnectionTestDecision;
  invocationId: string;
  /** Present (with `decision: "allowed"`) when the call ran to completion. */
  result?: unknown;
  /** Present on a failed allowed run, or as the explanation for an off action. */
  error?: { message: string; reasonCode: ToolAccessReasonCode | string | null };
  /** Present (with `decision: "ask_first"`) — the parked approval request. */
  actionRequestId?: string;
}

/**
 * Lifecycle phase of an ask-first test call, polled through
 * `GET /tool-connections/:id/test-calls/:actionRequestId`.
 *
 * - `waiting`   — approval still pending in the Review tab.
 * - `running`   — approved; the tool is executing for the test.
 * - `done`      — approved and finished; see `result` / `error`.
 * - `denied`    — declined in the Review tab.
 * - `cancelled` — request was cancelled or invalidated before approval.
 * - `expired`   — the approval window lapsed.
 */
export type ToolConnectionTestCallStatusPhase =
  | "waiting"
  | "running"
  | "done"
  | "denied"
  | "cancelled"
  | "expired";

/** Live status of an ask-first test call (`GET /tool-connections/:id/test-calls/:actionRequestId`). */
export interface ToolConnectionTestCallStatus {
  actionRequestId: string;
  invocationId: string;
  phase: ToolConnectionTestCallStatusPhase;
  /** Redacted snapshot of the parameters the call was made with — powers the "Where" row. */
  parameters?: Record<string, unknown> | null;
  /** Present once `phase === "done"` and the tool succeeded. */
  result?: unknown;
  /** Present once `phase === "done"` and the tool failed, or when the request was denied/expired. */
  error?: { message: string; reasonCode: ToolAccessReasonCode | string | null };
  /** Wall-clock duration of the executed call in ms, when known. */
  durationMs?: number | null;
  /** ISO timestamp the request was created — for the "Waiting · {time}" label. */
  requestedAt: string;
  /** ISO timestamp the request was resolved (approved/denied/cancelled), when applicable. */
  resolvedAt?: string | null;
}
