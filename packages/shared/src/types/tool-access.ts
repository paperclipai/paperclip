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
  ToolInvocationApprovalState,
  ToolInvocationStatus,
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
  ToolInvocationApprovalState,
  ToolInvocationStatus,
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

export interface McpConnectionCredentialRef {
  name: string;
  secretId: string;
  version?: number | "latest";
  placement: "header" | "env";
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

export interface ToolProfileWithDetails extends ToolProfile {
  entries: ToolProfileEntry[];
  bindings: ToolProfileBinding[];
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
  | "pending_action_requests";

export interface ToolAppAttentionItem {
  connection: ToolConnection;
  healthNeedsAttention: boolean;
  quarantinedCatalogEntryCount: number;
  pendingActionRequestCount: number;
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
  };
}

/** Recent tool-call events for a single app connection (App detail · Recent activity). */
export interface ToolConnectionActivityResponse {
  connectionId: string;
  events: ToolCallEvent[];
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
  } | null;
  request: {
    applicationId?: string | null;
    connectionId?: string | null;
    catalogEntryId?: string | null;
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
  argumentsSummary?: ToolRedactedValueSummary | null;
  rateLimitState?: Record<string, unknown> | null;
  invocationId?: string | null;
  actionRequestId?: string | null;
}
