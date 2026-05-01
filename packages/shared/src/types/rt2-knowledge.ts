export type Rt2WikiPageType = "index" | "log" | "topic" | "project" | "schema";
export type Rt2WikiConfidenceLabel = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
export type Rt2WikiContradictionStatus = "none" | "unknown" | "unresolved" | "resolved";

export interface Rt2WikiConfidenceSummary {
  EXTRACTED: number;
  INFERRED: number;
  AMBIGUOUS: number;
}

export interface Rt2WikiPageProvenance {
  source: "domain_event_projector" | "obsidian_vault_import" | "obsidian_conflict_resolution" | "jarvis_rewrite";
  sourceEventIds: string[];
  sourceEventTypes: string[];
  entityRefs: Array<{
    entityType: string;
    entityId: string;
  }>;
  generatedAt: string;
}

export interface Rt2WikiPageUpdateEvidence {
  reason: string;
  touchedPageKeys: string[];
  sourceEventIds: string[];
  sourceEventCount: number;
  relatedPageKeys: string[];
  generatedAt: string;
  actorId?: string | null;
  proposalId?: string | null;
  citationIds?: string[];
}

export interface Rt2WikiPage {
  id: string;
  companyId: string;
  pageKey: string;
  pageType: Rt2WikiPageType;
  title: string;
  markdown: string;
  summary: string[];
  sourceEventIds: string[];
  metadata: Record<string, unknown>;
  provenance?: Rt2WikiPageProvenance;
  confidenceSummary?: Rt2WikiConfidenceSummary;
  contradictionStatus?: Rt2WikiContradictionStatus;
  relatedPageKeys?: string[];
  updateEvidence?: Rt2WikiPageUpdateEvidence | null;
  createdAt: string;
  updatedAt: string;
}

export interface Rt2WikiPageList {
  companyId: string;
  pages: Rt2WikiPage[];
}

export interface Rt2KnowledgeProjectionResult {
  companyId: string;
  processedEvents: number;
  pendingEvents: number;
  wikiPages: number;
  graphNodes: number;
  graphEdges: number;
  lastProjectedAt: string | null;
}

export interface Rt2ObsidianVaultFile {
  path: string;
  title: string;
  pageKey: string;
  content: string;
  sourceEventIds: string[];
  updatedAt: string;
}

export interface Rt2ObsidianVaultExport {
  companyId: string;
  vaultName: string;
  generatedAt: string;
  files: Rt2ObsidianVaultFile[];
}

export interface Rt2WikiLLMExportFile {
  path: string;
  title: string;
  pageKey: string;
  pageType: Rt2WikiPageType;
  content: string;
  sourceEventIds: string[];
  updatedAt: string;
  provenance: Rt2WikiPageProvenance | null;
  confidenceSummary: Rt2WikiConfidenceSummary;
  contradictionStatus: Rt2WikiContradictionStatus;
  relatedPageKeys: string[];
  updateEvidence: Rt2WikiPageUpdateEvidence | null;
}

export interface Rt2WikiLLMExport {
  companyId: string;
  model: "wikillm-compatible-file-model";
  generatedAt: string;
  fileCount: number;
  files: Rt2WikiLLMExportFile[];
}

export type Rt2KnowledgeEvidenceStatus = "ready" | "missing" | "stale" | "ambiguous";

export type Rt2ObsidianVaultWriterMode = "dry_run" | "local_path";

export interface Rt2ObsidianVaultWriterSettingsInput {
  vaultName?: string;
  rootPath: string;
  exportSubdirectory?: string;
  writerMode?: Rt2ObsidianVaultWriterMode;
}

export interface Rt2ObsidianVaultDryRunFile {
  path: string;
  action: "create" | "update" | "skip" | "conflict";
  pageKey: string;
  title: string;
  conflictRisk: Rt2KnowledgeEvidenceStatus;
  reason: string;
}

export interface Rt2ObsidianVaultDryRunResult {
  companyId: string;
  vaultName: string;
  rootPath: string;
  exportPath: string;
  writerMode: Rt2ObsidianVaultWriterMode;
  fileCount: number;
  conflictCount: number;
  generatedAt: string;
  files: Rt2ObsidianVaultDryRunFile[];
  warnings: string[];
}

export interface Rt2ObsidianVaultWriterSettings {
  companyId: string;
  vaultName: string;
  rootPath: string;
  exportSubdirectory: string;
  exportPath: string;
  writerMode: Rt2ObsidianVaultWriterMode;
  lastDryRun: Rt2ObsidianVaultDryRunResult | null;
  updatedAt: string;
}

export type Rt2LocalBridgeStatus = "paired" | "available" | "unavailable" | "stale" | "blocked" | "conflict";
export type Rt2LocalBridgeQueueOperation = "export" | "import" | "conflict_resolution";
export type Rt2LocalBridgeQueueStatus = "queued" | "running" | "applied" | "blocked" | "conflict" | "failed";

export interface Rt2LocalBridgePairingRequest {
  bridgeName?: string;
  vaultName?: string;
}

export interface Rt2LocalBridgePairing {
  id: string;
  companyId: string;
  bridgeName: string;
  vaultName: string;
  status: Rt2LocalBridgeStatus;
  blockedReason: string | null;
  conflictCount: number;
  lastSeenAt: string | null;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Rt2LocalBridgePairingResult {
  bridge: Rt2LocalBridgePairing;
  pairingToken: string;
}

export interface Rt2LocalBridgeHeartbeatInput {
  bridgeId: string;
  pairingToken: string;
  status?: Rt2LocalBridgeStatus;
  blockedReason?: string | null;
  conflictCount?: number;
  metadata?: Record<string, unknown>;
}

export interface Rt2LocalBridgeQueueInput {
  operation: Rt2LocalBridgeQueueOperation;
  pageKey?: string;
  vaultPath?: string;
  candidateIds?: string[];
  blockedReason?: string | null;
}

export interface Rt2LocalBridgeQueueApplyInput {
  queueId: string;
  status?: Extract<Rt2LocalBridgeQueueStatus, "applied" | "blocked" | "conflict" | "failed">;
  blockedReason?: string | null;
  result?: Record<string, unknown>;
}

export interface Rt2LocalBridgeQueueItem {
  id: string;
  companyId: string;
  bridgeId: string | null;
  operation: Rt2LocalBridgeQueueOperation;
  status: Rt2LocalBridgeQueueStatus;
  pageKey: string | null;
  vaultPath: string | null;
  candidateIds: string[];
  blockedReason: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}

export interface Rt2LocalBridgeHealth {
  companyId: string;
  status: Rt2LocalBridgeStatus;
  generatedAt: string;
  bridge: Rt2LocalBridgePairing | null;
  queue: {
    queued: number;
    running: number;
    applied: number;
    blocked: number;
    conflict: number;
    failed: number;
  };
  lastAppliedAt: string | null;
  conflictCount: number;
  blockedReason: string | null;
  stale: boolean;
  reasons: Array<{
    code: "bridge_unpaired" | "bridge_unavailable" | "bridge_stale" | "bridge_blocked" | "bridge_conflicts";
    message: string;
  }>;
  recentQueue: Rt2LocalBridgeQueueItem[];
}

export interface Rt2ObsidianVaultImportFileInput {
  path: string;
  content: string;
}

export interface Rt2ObsidianVaultImportPreviewInput {
  vaultName?: string;
  projectId?: string;
  files: Rt2ObsidianVaultImportFileInput[];
}

export type Rt2KnowledgeImportCandidateKind = "wiki_page" | "graph_node" | "graph_edge";
export type Rt2KnowledgeImportCandidateAction = "create" | "update" | "skip" | "conflict";
export type Rt2KnowledgeConflictResolution = "rt2_wins" | "vault_wins" | "manual_merge";
export type Rt2ContradictionCandidateStatus = "open" | "resolved";
export type Rt2ContradictionResolutionDecision = "false_positive" | "accept_newer" | "keep_older" | "request_follow_up";

export interface Rt2ContradictionCandidate {
  id: string;
  companyId: string;
  projectId: string | null;
  status: Rt2ContradictionCandidateStatus;
  reasonCode: string;
  title: string;
  explanation: string | null;
  sourceType: string;
  sourceId: string;
  sourceKey: string;
  conflictingSourceType: string;
  conflictingSourceId: string;
  conflictingSourceKey: string;
  confidence: string;
  rawEvidence: Array<Record<string, unknown>>;
  deterministicSignals: Record<string, unknown>;
  providerExplanation: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface Rt2ContradictionCandidateList {
  companyId: string;
  candidates: Rt2ContradictionCandidate[];
}

export interface Rt2ContradictionGenerateResult {
  companyId: string;
  projectId: string;
  checkedPages: number;
  semanticComparisons: number;
  candidatesCreated: number;
  candidates: Rt2ContradictionCandidate[];
}

export interface Rt2ContradictionResolutionInput {
  decision: Rt2ContradictionResolutionDecision;
  reason: string;
  followUpIssueId?: string | null;
}

export type Rt2KnowledgeOperationsHealthStatus = "healthy" | "degraded" | "failed";

export type Rt2KnowledgeOperationsReasonCode =
  | "semantic_index_missing"
  | "semantic_index_last_run_failed"
  | "semantic_index_running"
  | "semantic_index_stale_chunks"
  | "contradictions_open"
  | "jarvis_grounding_unavailable"
  | "jarvis_grounding_at_risk"
  | "jarvis_rewrite_provider_unavailable"
  | "jarvis_rewrite_eval_disagreement"
  | "jarvis_rewrite_low_confidence"
  | "jarvis_rewrite_blocked";

export interface Rt2KnowledgeOperationsReason {
  code: Rt2KnowledgeOperationsReasonCode;
  severity: Rt2KnowledgeOperationsHealthStatus;
  message: string;
  count?: number;
}

export interface Rt2KnowledgeOperationsSemanticHealth {
  status: Rt2KnowledgeOperationsHealthStatus;
  indexedChunks: number;
  sourceCount: number;
  staleChunks: number;
  providerMode: "provider" | "fallback" | null;
  embeddingModel: string | null;
  latestRun: {
    id: string;
    mode: "full" | "changed";
    status: "running" | "completed" | "error";
    providerMode: "provider" | "fallback";
    embeddingModel: string;
    sourcesScanned: number;
    chunksRefreshed: number;
    chunksSkipped: number;
    errorMessage: string | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
  lastSuccessfulRun: {
    id: string;
    mode: "full" | "changed";
    providerMode: "provider" | "fallback";
    embeddingModel: string;
    sourcesScanned: number;
    chunksRefreshed: number;
    chunksSkipped: number;
    startedAt: string;
    completedAt: string;
  } | null;
}

export interface Rt2KnowledgeOperationsContradictionHealth {
  status: Rt2KnowledgeOperationsHealthStatus;
  openCandidates: number;
  resolvedCandidates: number;
  recentlyResolved: number;
}

export interface Rt2KnowledgeOperationsJarvisHealth {
  status: Rt2KnowledgeOperationsHealthStatus;
  taskCount: number;
  groundingAvailable: boolean;
  warningSources: {
    staleChunks: number;
    openContradictions: number;
  };
  rewriteProposals?: {
    total: number;
    blocked: number;
    highRisk: number;
    providerUnavailable: number;
    disagreement: number;
    lowConfidence: number;
  };
}

export interface Rt2KnowledgeOperationsHealth {
  companyId: string;
  status: Rt2KnowledgeOperationsHealthStatus;
  generatedAt: string;
  semanticIndex: Rt2KnowledgeOperationsSemanticHealth;
  contradictionReview: Rt2KnowledgeOperationsContradictionHealth;
  jarvisGrounding: Rt2KnowledgeOperationsJarvisHealth;
  reasons: Rt2KnowledgeOperationsReason[];
  flowLinks: Array<{
    label: string;
    target: "search" | "bridge" | "jarvis" | "semantic-index";
    path: string;
  }>;
}

export interface Rt2ObsidianVaultImportPreviewFile {
  path: string;
  pageKey: string | null;
  pageType: Rt2WikiPageType | null;
  title: string;
  sourceEventIds: string[];
  status: Rt2KnowledgeEvidenceStatus;
  warnings: string[];
}

export interface Rt2KnowledgeImportCandidate {
  id: string;
  kind: Rt2KnowledgeImportCandidateKind;
  action: Rt2KnowledgeImportCandidateAction;
  path: string;
  targetKey: string;
  label: string;
  status: Rt2KnowledgeEvidenceStatus;
  beforeSummary: string | null;
  afterSummary: string;
  warnings: string[];
}

export interface Rt2ObsidianVaultImportPreview {
  companyId: string;
  vaultName: string;
  fileCount: number;
  importedEventIds: string[];
  matchedEventIds: string[];
  missingEventIds: string[];
  evidenceStatus: Rt2KnowledgeEvidenceStatus;
  files: Rt2ObsidianVaultImportPreviewFile[];
  candidates: Rt2KnowledgeImportCandidate[];
  conflicts: Rt2KnowledgeImportCandidate[];
  generatedAt: string;
}

export interface Rt2ObsidianVaultImportApplyInput extends Rt2ObsidianVaultImportPreviewInput {
  approvedCandidateIds: string[];
  reason?: string;
}

export interface Rt2ObsidianVaultImportApplyResult {
  companyId: string;
  appliedCandidateIds: string[];
  skippedCandidateIds: string[];
  updatedWikiPages: number;
  updatedGraphNodes: number;
  updatedGraphEdges: number;
  auditId: string;
  appliedAt: string;
}

export interface Rt2ObsidianVaultConflictResolutionInput {
  projectId?: string;
  file: Rt2ObsidianVaultImportFileInput;
  decision: Rt2KnowledgeConflictResolution;
  manualMarkdown?: string;
  reason: string;
}

export interface Rt2ObsidianVaultConflictResolutionResult {
  companyId: string;
  pageKey: string;
  decision: Rt2KnowledgeConflictResolution;
  applied: boolean;
  auditId: string;
  resolvedAt: string;
}
