import type {
  AssignRt2Participant,
  CreateRt2Task,
  OneLinerDraft,
  OneLinerRewardEvidence,
  CreateRt2Todo,
  EndRt2Participant,
  Issue,
  Rt2BoardAttachmentPreview,
  Rt2BoardCardMeta,
  Rt2BoardChecklistItem,
  Rt2BoardOverview,
  Rt2CaptureDraftSummary,
  Rt2CaptureDraftDetail,
  Rt2CaptureQueue,
  Rt2CaptureQueueFilters,
  Rt2CaptureReliabilityReport,
  Rt2CaptureSourceSummary,
  UpdateRt2TaskCapacity,
} from "@paperclipai/shared";
import { api } from "./client";

export type Rt2TaskParticipant = {
  id: string;
  taskIssueId: string;
  userId: string;
  state: "active" | "ended";
  endedReason: EndRt2Participant["reason"] | null;
  joinedAt: Date;
  endedAt: Date | null;
};

export type Rt2AssignableUser = {
  userId: string;
  membershipRole: string | null;
};

export type Rt2ExecutionSummary = {
  id: string;
  taskIssueId: string;
  todoIssueId: string | null;
  state: "queued" | "dispatched" | "claimed" | "running" | "completed" | "failed" | "cancelled" | "blocked";
  executorType: "user" | "jarvis" | "runtime" | null;
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
};

export type Rt2ExecutionTimelineEvent = {
  id: string;
  source: "rt2_domain_event" | "heartbeat";
  kind: "lifecycle" | "progress" | "message" | "tool" | "cleanup";
  type: string;
  message: string | null;
  seq: number | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
};

export type Rt2TaskSummary = {
  issueId: string;
  projectId: string;
  goalId: string | null;
  title: string;
  description: string | null;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  taskMode: "solo" | "collab";
  capacity: number;
  activeParticipantCount: number;
  deliverableCount: number;
  todoCount: number;
  todoInProgressCount: number;
  execution: Rt2ExecutionSummary | null;
};

export type Rt2DeliverableSummary = {
  workProductId: string;
  issueId: string;
  title: string;
  type: "document" | "artifact";
  state: "defined" | "submitted";
  basePrice: number | null;
  summary: string | null;
  isRequired: boolean;
};

export type Rt2TodoSummary = {
  issueId: string;
  parentTaskIssueId: string;
  title: string;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  assigneeUserId: string | null;
  deliverableCount: number;
  submittedDeliverableCount: number;
  execution: Rt2ExecutionSummary | null;
};

export type Rt2TaskDetail = Rt2TaskSummary & {
  participants: Rt2TaskParticipant[];
  deliverables: Rt2DeliverableSummary[];
  todos: Rt2TodoSummary[];
};

type Rt2TaskCapacityResponse = {
  issueId: string;
  companyId: string;
  projectId: string;
  capacity: number;
};

type Rt2EndParticipantResponse = {
  issueId: string;
  companyId: string;
  projectId: string;
  userId: string;
  reason: EndRt2Participant["reason"];
};

export type Rt2TaskCreateResponse = {
  issueId: string;
  deliverables: Array<{
    title: string;
    type: "document" | "artifact";
    basePrice: number;
  }>;
  rewardEvidence: OneLinerRewardEvidence;
};

export type Rt2InboundDraftResponse = {
  draft: OneLinerDraft;
  inbound: {
    id: string;
    source: Rt2InboundDraftSource;
    channel: string | null;
    externalUserId: string | null;
    status: Rt2CaptureDraftSummary["status"];
    duplicateOfDraftId: string | null;
    permissionStatus: Rt2CaptureDraftSummary["permissionStatus"];
    sourceEvidence: Rt2CaptureDraftSummary["sourceEvidence"];
    semanticContext: Rt2CaptureDraftSummary["semanticContext"];
    duplicateWarning: string | null;
    reviewRequired: boolean;
  };
};

export type Rt2InboundDraftSource = "web" | "floating" | "voice" | "slack" | "teams" | "webhook" | "mobile" | "native";

export const rt2TasksApi = {
  listByProject: (companyId: string, projectId: string) =>
    api.get<Rt2TaskSummary[]>(`/companies/${companyId}/rt2/tasks?projectId=${encodeURIComponent(projectId)}`),
  get: (taskIssueId: string) =>
    api.get<Rt2TaskDetail>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}`),
  listAssignableUsers: (taskIssueId: string) =>
    api.get<Rt2AssignableUser[]>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}/assignable-users`),
  create: (companyId: string, data: CreateRt2Task) =>
    api.post<Rt2TaskCreateResponse>(`/companies/${companyId}/rt2/tasks`, data),
  createInboundDraft: (companyId: string, data: {
    source: Rt2InboundDraftSource;
    text: string;
    channel?: string | null;
    externalUserId?: string | null;
    sourceInstallationId?: string | null;
    eventId?: string | null;
    eventTimestamp?: string | null;
    signature?: string | null;
  }) => api.post<Rt2InboundDraftResponse>(`/companies/${companyId}/rt2/one-liner/inbound-draft`, data),
  listCaptureSources: (companyId: string) =>
    api.get<Rt2CaptureSourceSummary[]>(`/companies/${companyId}/rt2/capture-sources`),
  upsertCaptureSource: (companyId: string, source: Rt2InboundDraftSource, data: {
    source: Rt2InboundDraftSource;
    label?: string;
    installationState?: Rt2CaptureSourceSummary["installationState"];
    signingStatus?: Rt2CaptureSourceSummary["signingStatus"];
    signingSecret?: string;
    blockedReason?: string | null;
    lastErrorCode?: string | null;
  }) => api.put<Rt2CaptureSourceSummary>(`/companies/${companyId}/rt2/capture-sources/${encodeURIComponent(source)}`, data),
  getBoardOverview: (companyId: string, issueIds: string[]) =>
    api.get<Rt2BoardOverview>(`/companies/${companyId}/rt2/work-board?issueIds=${encodeURIComponent(issueIds.join(","))}`),
  updateBoardCard: (companyId: string, issueId: string, data: {
    dueDate?: string | null;
    qualityStatus?: Rt2BoardCardMeta["qualityStatus"];
    priceGold?: number | null;
    detailNotes?: string | null;
  }) => api.patch<Rt2BoardCardMeta>(`/companies/${companyId}/rt2/work-board/cards/${encodeURIComponent(issueId)}`, data),
  addChecklistItem: (companyId: string, issueId: string, data: { title: string }) =>
    api.post<Rt2BoardChecklistItem>(`/companies/${companyId}/rt2/work-board/cards/${encodeURIComponent(issueId)}/checklist`, data),
  updateChecklistItem: (companyId: string, issueId: string, itemId: string, data: { title?: string; checked?: boolean }) =>
    api.patch<Rt2BoardChecklistItem>(`/companies/${companyId}/rt2/work-board/cards/${encodeURIComponent(issueId)}/checklist/${encodeURIComponent(itemId)}`, data),
  reorderChecklist: (companyId: string, issueId: string, orderedItemIds: string[]) =>
    api.post<Rt2BoardChecklistItem[]>(`/companies/${companyId}/rt2/work-board/cards/${encodeURIComponent(issueId)}/checklist/reorder`, { orderedItemIds }),
  addBoardAttachment: (companyId: string, issueId: string, data: { label: string; url: string; contentType?: string | null }) =>
    api.post<Rt2BoardAttachmentPreview>(`/companies/${companyId}/rt2/work-board/cards/${encodeURIComponent(issueId)}/attachments`, data),
  listCaptureQueue: (companyId: string, filters?: Partial<Rt2CaptureQueueFilters>) => {
    const params = new URLSearchParams();
    if (filters?.sources?.length) params.set("source", filters.sources.join(","));
    if (filters?.statuses?.length) params.set("status", filters.statuses.join(","));
    if (filters?.evidence?.length) params.set("evidence", filters.evidence.join(","));
    const query = params.toString();
    return api.get<Rt2CaptureQueue>(`/companies/${companyId}/rt2/capture-drafts${query ? `?${query}` : ""}`);
  },
  getCaptureReliabilityReport: (companyId: string) =>
    api.get<Rt2CaptureReliabilityReport>(`/companies/${companyId}/rt2/capture-drafts/reliability-report`),
  getCaptureDraft: (companyId: string, draftId: string) =>
    api.get<Rt2CaptureDraftDetail>(`/companies/${companyId}/rt2/capture-drafts/${encodeURIComponent(draftId)}`),
  reviseCaptureDraft: (companyId: string, draftId: string, data: {
    snapshot: {
      taskTitle: string;
      todoTitle?: string;
      deliverableTitle: string;
      deliverableType?: "document" | "artifact";
      basePrice?: number | null;
      taskMode?: "solo" | "collab";
      capacity?: number;
      qualityHint?: string | null;
      goalId?: string | null;
      okrCandidate?: string | null;
      sourceEvidenceNote?: string | null;
      operatorNote?: string | null;
    };
    changeSummary?: string;
  }) => api.post<Rt2CaptureDraftSummary>(`/companies/${companyId}/rt2/capture-drafts/${encodeURIComponent(draftId)}/revisions`, data),
  transitionCaptureDraft: (companyId: string, draftId: string, data: {
    action: "hold" | "reject" | "request_revision" | "mark_review_required";
    reason?: string;
  }) => api.post<Rt2CaptureDraftSummary>(`/companies/${companyId}/rt2/capture-drafts/${encodeURIComponent(draftId)}/transition`, data),
  promoteCaptureDraft: (companyId: string, draftId: string, data:
    | { target: "task"; projectId: string; goalId?: string | null; taskMode?: "solo" | "collab"; capacity?: number; priority?: "critical" | "high" | "medium" | "low" }
    | { target: "todo"; taskIssueId: string; assigneeUserId: string }
    | { target: "deliverable"; issueId: string }
  ) => api.post<Rt2CaptureDraftSummary>(`/companies/${companyId}/rt2/capture-drafts/${encodeURIComponent(draftId)}/promote`, data),
  failCaptureDraft: (companyId: string, draftId: string, data: { failureCode: "source_failure" | "duplicate" | "permission" | "parse_error"; failureMessage: string }) =>
    api.post<Rt2CaptureDraftSummary>(`/companies/${companyId}/rt2/capture-drafts/${encodeURIComponent(draftId)}/fail`, data),
  join: (taskIssueId: string) =>
    api.post<Rt2TaskParticipant>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}/join`, {}),
  assignParticipant: (taskIssueId: string, data: AssignRt2Participant) =>
    api.post<Rt2TaskParticipant>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}/participants`, data),
  updateCapacity: (taskIssueId: string, data: UpdateRt2TaskCapacity) =>
    api.patch<Rt2TaskCapacityResponse>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}/capacity`, data),
  createTodo: (taskIssueId: string, data: CreateRt2Todo) =>
    api.post<Issue>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}/todos`, data),
  startTodo: (todoIssueId: string) =>
    api.post<Issue>(`/rt2/todos/${encodeURIComponent(todoIssueId)}/start`, {}),
  enqueueExecution: (taskIssueId: string, data: {
    todoIssueId?: string | null;
    deliverableWorkProductId?: string | null;
    executionWorkspaceId?: string | null;
    metadata?: Record<string, unknown>;
  }) => api.post<Rt2ExecutionSummary>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}/executions`, data),
  dispatchExecution: (attemptId: string, data: {
    executorType: "user" | "jarvis" | "runtime";
    executorId: string;
    executionWorkspaceId?: string | null;
    runtimeServiceId?: string | null;
    heartbeatRunId?: string | null;
    capacity?: number;
    runtimeFreshnessSeconds?: number;
  }) => api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/dispatch`, data),
  claimExecution: (attemptId: string, data: {
    executorType: "user" | "jarvis" | "runtime";
    executorId: string;
    executionWorkspaceId?: string | null;
    runtimeServiceId?: string | null;
    heartbeatRunId?: string | null;
  }) => api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/claim`, data),
  dispatchNextExecution: (companyId: string, data: {
    executorType: "user" | "jarvis" | "runtime";
    executorId: string;
    executionWorkspaceId?: string | null;
    runtimeServiceId?: string | null;
    heartbeatRunId?: string | null;
    capacity?: number;
    runtimeFreshnessSeconds?: number;
  }) => api.post<Rt2ExecutionSummary>(`/companies/${companyId}/rt2/executions/dispatch-next`, data),
  startExecution: (attemptId: string, data: { runtimeServiceId?: string | null; heartbeatRunId?: string | null } = {}) =>
    api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/start`, data),
  completeExecution: (attemptId: string, data: {
    resultWorkProductId?: string | null;
    missingDeliverableReason?: string | null;
  }) => api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/complete`, data),
  failExecution: (attemptId: string, data: { failureReason: string }) =>
    api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/fail`, data),
  cancelExecution: (attemptId: string, data: { reason?: string; cancelledBy?: string } = {}) =>
    api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/cancel`, data),
  getExecutionTimeline: (attemptId: string) =>
    api.get<Rt2ExecutionTimelineEvent[]>(`/rt2/executions/${encodeURIComponent(attemptId)}/timeline`),
  cleanupStaleExecutions: (companyId: string, data: { staleBefore?: string; reason?: string; limit?: number } = {}) =>
    api.post<{ staleBefore: Date; cleaned: Rt2ExecutionSummary[] }>(`/companies/${companyId}/rt2/executions/cleanup-stale`, data),
  retryExecution: (attemptId: string) =>
    api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/retry`, {}),
  endParticipant: (taskIssueId: string, userId: string, reason: EndRt2Participant["reason"]) =>
    api.post<Rt2EndParticipantResponse>(
      `/rt2/tasks/${encodeURIComponent(taskIssueId)}/participants/${encodeURIComponent(userId)}/end`,
      { reason },
    ),
};
