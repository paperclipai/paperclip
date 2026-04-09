export const channelWorkbenchScenarioDefinitions = [
  { key: "no_source", id: "S01", label: "无来源资料" },
  { key: "spec_incomplete", id: "S02", label: "规范未完成" },
  { key: "gate_failed", id: "S04", label: "Gate 未通过" },
  { key: "gate_stale", id: "S06", label: "Gate 已过期" },
  { key: "passed_with_exception", id: "S08", label: "通过但有例外" },
  { key: "dod_blocked", id: "S09", label: "DoD 阻塞" },
] as const;

export type ChannelWorkbenchScenarioKey =
  (typeof channelWorkbenchScenarioDefinitions)[number]["key"];

export type ChannelWorkbenchScenarioDefinition =
  (typeof channelWorkbenchScenarioDefinitions)[number];

export const channelWorkbenchPageDefinitions = [
  { id: "source_documents", label: "来源资料" },
  { id: "spec_editor", label: "规范编辑" },
  { id: "gate_result", label: "Gate 结果" },
  { id: "issue_ledger", label: "问题账本" },
  { id: "snapshot_export", label: "快照与 AI 导出" },
  { id: "evidence_dod", label: "证据与 DoD" },
] as const;

export type ChannelWorkbenchPageId =
  (typeof channelWorkbenchPageDefinitions)[number]["id"];

export type ChannelWorkbenchPageDefinition =
  (typeof channelWorkbenchPageDefinitions)[number];

export interface ChannelWorkbenchAction {
  actionId: string;
  actionType: string;
  title: string;
  reason: string;
  impact: string;
  ownerRole: string;
  priority: number;
  isBlocking: boolean;
  ctaLabel: string;
  ctaType: "navigate" | "mutation";
  targetPage: ChannelWorkbenchPageId;
}

export interface ChannelWorkbenchBlockingItem {
  id: string;
  type: string;
  title: string;
  reason: string;
  ownerRole: string;
}

export interface ChannelWorkbenchOverview {
  caseId: string;
  caseTitle: string;
  channelName: string;
  currentStage: string;
  codingReadiness: string;
  latestGateSummaryStatus: string;
  latestSnapshotStatus: string;
  dodSummaryStatus: string;
  hasStaleGate: boolean;
  hasActiveException: boolean;
  activeExceptionCount: number;
  blockingIssueCount: number;
  currentSnapshot: null | {
    snapshotId: string;
    ruleVersion: string;
    frozenAt: string;
  };
  specProgress: {
    bundleExists: boolean;
    publishedSections: number;
    totalSections: number;
    draftSections: number;
    requiredMissingSections?: string[];
  };
  sourceProgress: {
    totalCount: number;
    criticalCount: number;
    snapshottedCount: number;
    inaccessibleCriticalCount: number;
  };
  issueProgress: {
    blockingIssueCount: number;
    openIssueCount: number;
    waitingExternalCount: number;
  };
  evidenceProgress: {
    requiredCount: number;
    completedCount: number;
    blockingCount: number;
  };
  topBlockingItems: ChannelWorkbenchBlockingItem[];
  statusSummary: {
    canEnterCoding: boolean;
    summaryText: string;
    reasonCode: string;
  };
}

export interface ChannelWorkbenchOverviewResponse {
  scenario: ChannelWorkbenchScenarioDefinition;
  fixturePaths: string[];
  overview: ChannelWorkbenchOverview;
}

export interface ChannelWorkbenchNextActionsResponse {
  scenario: ChannelWorkbenchScenarioDefinition;
  items: ChannelWorkbenchAction[];
}

export interface ChannelWorkbenchRerunGateResponse {
  previousScenario: ChannelWorkbenchScenarioDefinition;
  currentScenario: ChannelWorkbenchScenarioDefinition;
  caseId: string;
  caseTitle: string;
  gateRunId: string;
  executedAt: string;
  status: "accepted" | "completed";
  gateSummaryStatus: "running" | "failed" | "passed";
  message: string;
  targetPage: ChannelWorkbenchPageId;
}

export interface ChannelWorkbenchExportAiResponse {
  previousScenario: ChannelWorkbenchScenarioDefinition;
  currentScenario: ChannelWorkbenchScenarioDefinition;
  caseId: string;
  caseTitle: string;
  exportId: string;
  snapshotId: string;
  ruleVersion: string;
  executedAt: string;
  status: "accepted" | "completed";
  packageStatus: "queued" | "exported";
  message: string;
  targetPage: ChannelWorkbenchPageId;
}

export interface ChannelWorkbenchUploadEvidenceResponse {
  previousScenario: ChannelWorkbenchScenarioDefinition;
  currentScenario: ChannelWorkbenchScenarioDefinition;
  caseId: string;
  caseTitle: string;
  evidenceId: string;
  obligationId: string;
  executedAt: string;
  status: "accepted" | "completed";
  evidenceStatus: "queued" | "uploaded";
  completedEvidenceCount: number;
  remainingBlockingCount: number;
  dodSummaryStatus: "blocked" | "in_progress" | "complete";
  message: string;
  targetPage: ChannelWorkbenchPageId;
}

export interface ChannelWorkbenchSnapshotExportDetail {
  caseId: string;
  caseTitle: string;
  snapshotId: string | null;
  ruleVersion: string | null;
  frozenAt: string | null;
  latestGateSummaryStatus: string;
  hasActiveException: boolean;
  activeExceptionCount: number;
  packageStatus: "not_exported" | "queued" | "exported";
  notice: string;
  nextOwnerRole: string | null;
  nextStep: string;
  latestExport: null | {
    exportId: string;
    snapshotId: string;
    ruleVersion: string;
    exportedAt: string;
    status: "accepted" | "completed";
    packageStatus: "queued" | "exported";
  };
}

export interface ChannelWorkbenchSnapshotExportResponse {
  scenario: ChannelWorkbenchScenarioDefinition;
  fixturePaths: string[];
  detail: ChannelWorkbenchSnapshotExportDetail;
}

export interface ChannelWorkbenchDodItem {
  obligationId: string;
  obligationTitle: string;
  status: "missing" | "expired" | "complete";
  sourceSection: string;
  verificationType: string;
  environment: string;
  recommendedAction: "upload_evidence" | "reupload_evidence" | "none";
}

export interface ChannelWorkbenchEvidenceDodDetail {
  caseId: string;
  caseTitle: string;
  snapshotId: string | null;
  summaryStatus: "blocked" | "in_progress" | "complete";
  requiredObligationCount: number;
  completedObligationCount: number;
  blockingCount: number;
  nextOwnerRole: string | null;
  nextStep: string;
  latestUpload: null | {
    evidenceId: string;
    obligationId: string;
    uploadedAt: string;
    status: "accepted" | "completed";
    evidenceStatus: "queued" | "uploaded";
  };
  items: ChannelWorkbenchDodItem[];
}

export interface ChannelWorkbenchEvidenceDodResponse {
  scenario: ChannelWorkbenchScenarioDefinition;
  fixturePaths: string[];
  detail: ChannelWorkbenchEvidenceDodDetail;
}

export interface ChannelWorkbenchGateFinding {
  findingId: string;
  ruleId: string;
  gateStage: string;
  severity: string;
  title: string;
  reason: string;
  ownerRole: string;
  allowException: string;
}

export interface ChannelWorkbenchGateResultDetail {
  caseId: string;
  gateRunId: string;
  snapshotId: string | null;
  ruleVersion: string | null;
  status: "failed" | "passed" | "stale" | "running";
  summaryStatus: "failed" | "passed" | "stale" | "running";
  startedAt: string | null;
  endedAt: string | null;
  linkedIssueCount: number;
  staleReason: string | null;
  nextOwnerRole: string | null;
  nextStep: string;
  gateSummary: {
    gate1Status: string;
    gate2Status: string;
    gate3Status: string;
  };
  findings: ChannelWorkbenchGateFinding[];
}

export interface ChannelWorkbenchGateResultResponse {
  scenario: ChannelWorkbenchScenarioDefinition;
  fixturePaths: string[];
  detail: ChannelWorkbenchGateResultDetail;
}

export interface ChannelWorkbenchIssueLedgerItem {
  issueId: string;
  title: string;
  severity: string;
  status: string;
  ownerName: string;
  dueAt: string | null;
  sourceRuleId: string | null;
  blockingStage: string;
}

export interface ChannelWorkbenchIssueLedgerResponse {
  scenario: ChannelWorkbenchScenarioDefinition;
  fixturePaths: string[];
  detail: {
    caseId: string;
    waitingExternalOnly: boolean;
    openCount: number;
    blockingCount: number;
    nextOwnerRole: string | null;
    nextStep: string;
    items: ChannelWorkbenchIssueLedgerItem[];
  };
}

export interface ChannelWorkbenchSourceDocumentItem {
  sourceId: string;
  sourceType: string;
  sourceTitle: string;
  isCritical: boolean;
  snapshotStatus: string;
  availabilityStatus: string;
  ownerName: string;
}

export interface ChannelWorkbenchSourceDocumentsResponse {
  scenario: ChannelWorkbenchScenarioDefinition;
  fixturePaths: string[];
  detail: {
    caseId: string;
    totalCount: number;
    criticalCount: number;
    snapshottedCount: number;
    inaccessibleCriticalCount: number;
    nextOwnerRole: string | null;
    nextStep: string;
    items: ChannelWorkbenchSourceDocumentItem[];
  };
}

export interface ChannelWorkbenchSpecSectionItem {
  sectionId: string;
  sectionType: string;
  title: string;
  status: string;
  completedFields: number;
  totalFields: number;
  lintStatus: string;
  lastPublishedAt: string | null;
}

export interface ChannelWorkbenchSpecEditorResponse {
  scenario: ChannelWorkbenchScenarioDefinition;
  fixturePaths: string[];
  detail: {
    caseId: string;
    bundleId: string;
    templateVersion: string;
    riskTier: string;
    publishedSections: number;
    totalSections: number;
    draftSections: number;
    errorSections: number;
    warnSections: number;
    nextOwnerRole: string | null;
    nextStep: string;
    items: ChannelWorkbenchSpecSectionItem[];
  };
}

export interface ChannelWorkbenchRoleLane {
  role: string;
  label: string;
  status: "idle" | "assist" | "blocked";
  totalActions: number;
  blockingActions: number;
  summary: string;
  primaryAction: null | {
    actionId: string;
    actionType: string;
    title: string;
    reason: string;
    targetPage: ChannelWorkbenchPageId;
    priority: number;
    isBlocking: boolean;
  };
}

export interface ChannelWorkbenchRoleViewResponse {
  scenario: ChannelWorkbenchScenarioDefinition;
  fixturePaths: string[];
  detail: {
    caseId: string;
    caseTitle: string;
    lanes: ChannelWorkbenchRoleLane[];
  };
}
