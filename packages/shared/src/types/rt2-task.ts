export type Rt2TaskMode = "solo" | "collab";

export type Rt2ParticipantState = "active" | "ended";

export type Rt2ParticipantEndReason = "manager_removed" | "self_left" | "capacity_reduced";

export type Rt2DeliverableKind = "document" | "artifact";

export type Rt2DeliverableState = "defined" | "submitted";

export type Rt2ExecutionState =
  | "queued"
  | "dispatched"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export type Rt2ExecutionExecutorType = "user" | "jarvis" | "runtime";

export type Rt2ExecutionTimelineSource = "rt2_domain_event" | "heartbeat";
export type Rt2ExecutionTimelineEventKind = "lifecycle" | "progress" | "message" | "tool" | "cleanup";

export interface Rt2ExecutionTimelineEvent {
  id: string;
  source: Rt2ExecutionTimelineSource;
  kind: Rt2ExecutionTimelineEventKind;
  type: string;
  message: string | null;
  seq: number | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

export interface Rt2DeliverableInput {
  title: string;
  type: Rt2DeliverableKind;
  basePrice: number;
  summary?: string | null;
}

export interface Rt2TaskParticipant {
  id: string;
  taskIssueId: string;
  userId: string;
  state: Rt2ParticipantState;
  endedReason: Rt2ParticipantEndReason | null;
  joinedAt: Date;
  endedAt: Date | null;
}

export interface Rt2TodoSummary {
  issueId: string;
  parentTaskIssueId: string;
  title: string;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  assigneeUserId: string | null;
  deliverableCount: number;
  submittedDeliverableCount: number;
  execution: Rt2ExecutionSummary | null;
}

export interface Rt2DeliverableSummary {
  workProductId: string;
  issueId: string;
  title: string;
  type: Rt2DeliverableKind;
  state: Rt2DeliverableState;
  basePrice: number | null;
  summary: string | null;
  isRequired: boolean;
}

export interface Rt2TaskSummary {
  issueId: string;
  projectId: string;
  goalId: string | null;
  title: string;
  description: string | null;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  taskMode: Rt2TaskMode;
  capacity: number;
  activeParticipantCount: number;
  deliverableCount: number;
  todoCount: number;
  todoInProgressCount: number;
  execution: Rt2ExecutionSummary | null;
}

export interface Rt2ExecutionSummary {
  id: string;
  taskIssueId: string;
  todoIssueId: string | null;
  state: Rt2ExecutionState;
  executorType: Rt2ExecutionExecutorType | null;
  executorId: string | null;
  executionWorkspaceId: string | null;
  runtimeServiceId: string | null;
  heartbeatRunId: string | null;
  deliverableWorkProductId: string | null;
  resultWorkProductId: string | null;
  retryOfAttemptId: string | null;
  failureReason: string | null;
  missingDeliverableReason: string | null;
  queuedAt: Date;
  claimedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  latestTimelineEvent: Rt2ExecutionTimelineEvent | null;
}

export interface Rt2TaskDetail extends Rt2TaskSummary {
  participants: Rt2TaskParticipant[];
  deliverables: Rt2DeliverableSummary[];
  todos: Rt2TodoSummary[];
}

export type Rt2BoardQualityStatus = "none" | "pending_review" | "reviewed" | "needs_work";

export interface Rt2BoardChecklistItem {
  id: string;
  issueId: string;
  title: string;
  checked: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Rt2BoardCardLabel {
  id: string;
  name: string;
  color: string;
}

export interface Rt2BoardCardMember {
  userId: string;
  name: string;
  avatarUrl?: string | null;
}

export interface Rt2BoardAttachmentPreview {
  id: string;
  issueId: string;
  label: string;
  url: string;
  contentType: string | null;
  previewKind: "link" | "image" | "document";
  position: number;
}

export interface Rt2BoardCardMeta {
  issueId: string;
  dueDate: string | null;
  qualityStatus: Rt2BoardQualityStatus;
  priceGold: number | null;
  detailNotes: string | null;
  checklist: Rt2BoardChecklistItem[];
  attachments: Rt2BoardAttachmentPreview[];
  checklistDone: number;
  checklistTotal: number;
  checklistProgress: number;
  labels: Rt2BoardCardLabel[];
  members: Rt2BoardCardMember[];
}

export interface Rt2BoardOverview {
  companyId: string;
  cards: Rt2BoardCardMeta[];
  filters: {
    lanes: string[];
    assigneeIds: string[];
    okrIds: string[];
    qualityStatuses: Rt2BoardQualityStatus[];
    due: Array<"overdue" | "today" | "upcoming" | "none">;
  };
}

export type Rt2CaptureDraftSource = "web" | "floating" | "voice" | "slack" | "teams" | "webhook" | "mobile" | "native";
export type Rt2CaptureDraftStatus =
  | "review_required"
  | "revised"
  | "on_hold"
  | "revision_requested"
  | "rejected"
  | "duplicate"
  | "permission_blocked"
  | "failed"
  | "promoted"
  | "discarded";
export type Rt2CaptureQueueEvidenceFilter = "duplicate" | "failed_sync" | "approval_waiting" | "revised";
export interface Rt2CaptureQueueFilters {
  sources: Rt2CaptureDraftSource[];
  statuses: Rt2CaptureDraftStatus[];
  evidence: Rt2CaptureQueueEvidenceFilter[];
}
export type Rt2CaptureSourceInstallationState = "not_installed" | "installed" | "blocked" | "stale" | "error";
export type Rt2CaptureSourceSigningStatus = "unsigned" | "signed" | "invalid" | "missing" | "stale";

export interface Rt2CaptureDraftRevisionSummary {
  id: string;
  draftId: string;
  companyId: string;
  revisionNumber: number;
  snapshot: Record<string, unknown>;
  changeSummary: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface Rt2CaptureSourceSummary {
  id: string | null;
  companyId: string;
  source: Rt2CaptureDraftSource;
  label: string;
  installationState: Rt2CaptureSourceInstallationState;
  signingStatus: Rt2CaptureSourceSigningStatus;
  lastInboundEventAt: Date | null;
  lastInboundEventId: string | null;
  lastErrorCode: string | null;
  blockedReason: string | null;
  updatedAt: Date | null;
}

export interface Rt2CaptureSourceEvidence {
  sourceInstallationId: string | null;
  installationState: Rt2CaptureSourceInstallationState;
  signingStatus: Rt2CaptureSourceSigningStatus;
  eventId: string | null;
  eventTimestamp: string | null;
  reasonCode: string | null;
  metadata?: Record<string, string> | null;
}

export interface Rt2CaptureSemanticContextItem {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceKey: string;
  title: string;
  snippet: string;
  score: number;
  freshness: "fresh" | "stale" | "unknown";
  confidence: string;
  contradictionStatus: "none" | "unknown" | "unresolved" | "resolved";
  citationTarget: string | null;
}

export interface Rt2CaptureDraftSummary {
  id: string;
  companyId: string;
  source: Rt2CaptureDraftSource;
  channel: string | null;
  externalUserId: string | null;
  rawText: string;
  parsedDraft: Record<string, unknown>;
  status: Rt2CaptureDraftStatus;
  promotionTarget: "task" | "todo" | "deliverable" | null;
  promotedIssueId: string | null;
  promotedWorkProductId: string | null;
  duplicateOfDraftId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  permissionStatus: "allowed" | "missing_external_user" | "blocked";
  sourceEvidence: Rt2CaptureSourceEvidence | null;
  semanticContext: Rt2CaptureSemanticContextItem[];
  duplicateWarning: string | null;
  auditTrail: Array<Record<string, unknown>>;
  latestRevision: Rt2CaptureDraftRevisionSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Rt2CaptureDraftDetail extends Rt2CaptureDraftSummary {
  revisions: Rt2CaptureDraftRevisionSummary[];
}

export interface Rt2CaptureQueue {
  companyId: string;
  sources: Rt2CaptureSourceSummary[];
  summary: {
    reviewRequired: number;
    duplicate: number;
    permissionBlocked: number;
    failed: number;
    promoted: number;
  };
  drafts: Rt2CaptureDraftSummary[];
}

export interface Rt2CaptureReliabilityReportMetrics {
  draftCount: number;
  reviewRequiredCount: number;
  revisedCount: number;
  duplicateCount: number;
  failureCount: number;
  permissionBlockedCount: number;
  promotedCount: number;
  retryCount: number;
  averagePromotionLatencyMinutes: number | null;
  maxPromotionLatencyMinutes: number | null;
}

export interface Rt2CaptureReliabilityReportSourceRow extends Rt2CaptureReliabilityReportMetrics {
  source: Rt2CaptureDraftSource;
  label: string;
}

export interface Rt2CaptureReliabilityReport {
  companyId: string;
  generatedAt: Date;
  totals: Rt2CaptureReliabilityReportMetrics;
  rows: Rt2CaptureReliabilityReportSourceRow[];
}
