import type {
  MemoryBindingTargetType,
  MemoryExtractionHarness,
  MemoryExtractionJobStatus,
  MemoryHookExtractionMode,
  MemoryHookKind,
  MemoryHookRunMode,
  MemoryOperationStatus,
  MemoryOperationType,
  MemoryPrincipalType,
  MemoryProviderKind,
  MemoryRetentionState,
  MemoryReviewState,
  MemoryScopeType,
  MemorySensitivityLabel,
  MemorySourceKind,
  MemoryTriggerKind,
} from "../constants.js";
import type { BackgroundJob, BackgroundJobRun } from "./background-job.js";

export interface MemoryProviderCapabilities {
  browse: boolean;
  correction: boolean;
  asyncIngestion: boolean;
  providerManagedExtraction: boolean;
}

export type MemoryProviderConfigFieldInput =
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "path"
  | "secret";

export interface MemoryProviderConfigFieldOption {
  value: string | number | boolean | null;
  label: string;
  description?: string | null;
}

export interface MemoryProviderConfigFieldMetadata {
  key: string;
  label: string;
  description?: string | null;
  input: MemoryProviderConfigFieldInput;
  required?: boolean;
  secret?: boolean;
  defaultValue?: unknown;
  suggestedValue?: unknown;
  placeholder?: string | null;
  min?: number | null;
  max?: number | null;
  options?: MemoryProviderConfigFieldOption[];
}

export type MemoryProviderHealthStatus = "ok" | "warning" | "error" | "unknown";

export interface MemoryProviderHealthCheck {
  key: string;
  label: string;
  status: MemoryProviderHealthStatus;
  message?: string | null;
  details?: Record<string, unknown> | null;
}

export interface MemoryProviderConfigPathSuggestion {
  key: string;
  label: string;
  path: string;
  description?: string | null;
}

export interface MemoryProviderConfigMetadata {
  fields: MemoryProviderConfigFieldMetadata[];
  suggestedConfig: Record<string, unknown>;
  pathSuggestions?: MemoryProviderConfigPathSuggestion[];
  healthChecks?: MemoryProviderHealthCheck[];
}

export interface MemoryProviderDescriptor {
  key: string;
  displayName: string;
  description: string | null;
  kind: MemoryProviderKind;
  pluginId: string | null;
  capabilities: MemoryProviderCapabilities;
  configSchema: Record<string, unknown> | null;
  configMetadata: MemoryProviderConfigMetadata | null;
}

export interface MemoryHookPolicy {
  enabled: boolean;
  extractionMode: MemoryHookExtractionMode;
  runMode: MemoryHookRunMode;
  harness: MemoryExtractionHarness;
  sensitivityLabel: MemorySensitivityLabel;
  reviewState: MemoryReviewState;
  retentionPolicy?: Record<string, unknown> | null;
  modelProvider?: string | null;
  model?: string | null;
  config?: Record<string, unknown> | null;
}

export type MemoryHookPolicyMap = Partial<Record<MemoryHookKind, Partial<MemoryHookPolicy>>>;

export interface MemoryUsage {
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  costCents: number;
  latencyMs: number | null;
  details: Record<string, unknown> | null;
}

export interface MemoryGovernedScope {
  type: MemoryScopeType;
  id?: string | null;
}

export interface MemoryPrincipalRef {
  type: MemoryPrincipalType;
  id: string;
}

export interface MemoryCitation {
  label?: string | null;
  url?: string | null;
  excerpt?: string | null;
  sourceTitle?: string | null;
  sourcePath?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryScope {
  scopeType?: MemoryScopeType | null;
  scopeId?: string | null;
  agentId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  issueId?: string | null;
  runId?: string | null;
  teamId?: string | null;
  subjectId?: string | null;
  allowedScopes?: MemoryGovernedScope[] | null;
  maxSensitivityLabel?: MemorySensitivityLabel | null;
}

export interface MemorySourceRef {
  kind: MemorySourceKind;
  issueId?: string | null;
  commentId?: string | null;
  documentKey?: string | null;
  runId?: string | null;
  activityId?: string | null;
  externalRef?: string | null;
}

export interface MemoryBinding {
  id: string;
  companyId: string;
  key: string;
  name: string | null;
  providerKey: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryBindingTarget {
  id: string;
  companyId: string;
  bindingId: string;
  targetType: MemoryBindingTargetType;
  targetId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryResolvedBinding {
  companyId: string;
  targetType: MemoryBindingTargetType | null;
  targetId: string | null;
  binding: MemoryBinding | null;
  source:
    | "binding_key"
    | "agent_override"
    | "project_override"
    | "company_default"
    | "unconfigured";
  checkedTargetTypes: MemoryBindingTargetType[];
}

export interface MemoryRecordHandle {
  providerKey: string;
  recordId: string;
}

export interface MemoryRecord {
  id: string;
  companyId: string;
  bindingId: string;
  providerKey: string;
  scope: MemoryScope;
  source: MemorySourceRef | null;
  scopeType: MemoryScopeType;
  scopeId: string | null;
  owner: MemoryPrincipalRef | null;
  createdBy: MemoryPrincipalRef | null;
  sensitivityLabel: MemorySensitivityLabel;
  retentionPolicy: Record<string, unknown> | null;
  expiresAt: Date | null;
  retentionState: MemoryRetentionState;
  reviewState: MemoryReviewState;
  reviewedAt: Date | null;
  reviewedBy: MemoryPrincipalRef | null;
  reviewNote: string | null;
  citation: MemoryCitation | null;
  supersedesRecordId: string | null;
  supersededByRecordId: string | null;
  revokedAt: Date | null;
  revokedBy: MemoryPrincipalRef | null;
  revocationReason: string | null;
  title: string | null;
  content: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  createdByOperationId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryOperation {
  id: string;
  companyId: string;
  bindingId: string;
  providerKey: string;
  operationType: MemoryOperationType;
  triggerKind: MemoryTriggerKind;
  hookKind: MemoryHookKind | null;
  status: MemoryOperationStatus;
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId: string | null;
  userId: string | null;
  scope: MemoryScope;
  source: MemorySourceRef | null;
  queryText: string | null;
  recordCount: number;
  requestJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  policyDecision: Record<string, unknown> | null;
  revocationSelector: Record<string, unknown> | null;
  retentionAction: Record<string, unknown> | null;
  usage: MemoryUsage[];
  error: string | null;
  costEventId: string | null;
  financeEventId: string | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface MemoryExtractionJob {
  id: string;
  companyId: string;
  bindingId: string;
  providerKey: string;
  operationId: string | null;
  status: MemoryExtractionJobStatus;
  providerJobId: string | null;
  source: MemorySourceRef | null;
  resultJson: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryRefreshJobSourceCounts {
  issue: number;
  issue_comment: number;
  issue_document: number;
  run: number;
}

export interface MemoryRefreshJobResult {
  job: BackgroundJob;
  run: BackgroundJobRun;
  dryRun: boolean;
  sourceCounts: MemoryRefreshJobSourceCounts;
  recordCount: number;
}

export interface MemoryQueryResult {
  operation: MemoryOperation;
  records: MemoryRecord[];
  preamble: string | null;
}

export interface MemoryCaptureResult {
  operation: MemoryOperation;
  records: MemoryRecord[];
}

export interface MemoryForgetResult {
  operation: MemoryOperation;
  forgottenRecordIds: string[];
}

export interface MemoryProviderQueryInput {
  binding: MemoryBinding;
  scope: MemoryScope;
  query: string;
  topK?: number;
  intent?: "agent_preamble" | "answer" | "browse";
  metadataFilter?: Record<string, unknown>;
}

export interface MemoryProviderQueryOutput {
  records: MemoryRecord[];
  preamble?: string | null;
  usage?: MemoryUsage[];
  resultJson?: Record<string, unknown> | null;
}

export interface MemoryProviderCaptureInput {
  binding: MemoryBinding;
  scope: MemoryScope;
  source: MemorySourceRef;
  scopeType?: MemoryScopeType | null;
  scopeId?: string | null;
  owner?: MemoryPrincipalRef | null;
  createdBy?: MemoryPrincipalRef | null;
  sensitivityLabel?: MemorySensitivityLabel;
  retentionPolicy?: Record<string, unknown> | null;
  expiresAt?: string | Date | null;
  citation?: MemoryCitation | null;
  title?: string | null;
  content: string;
  summary?: string | null;
  metadata?: Record<string, unknown>;
  reviewState?: MemoryReviewState;
}

export interface MemoryProviderCaptureOutput {
  records: MemoryRecord[];
  usage?: MemoryUsage[];
  resultJson?: Record<string, unknown> | null;
}

export interface MemoryProviderForgetInput {
  binding: MemoryBinding;
  scope: MemoryScope;
  recordIds: string[];
}

export interface MemoryProviderForgetOutput {
  forgottenRecordIds: string[];
  usage?: MemoryUsage[];
  resultJson?: Record<string, unknown> | null;
}

export interface MemoryRevokeSelector {
  recordIds?: string[];
  source?: MemorySourceRef;
  runId?: string;
  issueId?: string;
  agentId?: string;
  workspaceId?: string;
  projectId?: string;
  teamId?: string;
  scopeType?: MemoryScopeType;
  scopeId?: string | null;
}

export interface MemoryRevokeResult {
  operations: MemoryOperation[];
  revokedRecordIds: string[];
}

export interface MemoryCorrectResult {
  operation: MemoryOperation;
  originalRecord: MemoryRecord;
  correctedRecord: MemoryRecord;
}

export interface MemoryReview {
  reviewState: MemoryReviewState;
  note?: string | null;
}

export interface MemoryReviewResult {
  operation: MemoryOperation;
  record: MemoryRecord;
}

export interface MemoryRetentionSweepResult {
  operations: MemoryOperation[];
  expiredRecordIds: string[];
}
