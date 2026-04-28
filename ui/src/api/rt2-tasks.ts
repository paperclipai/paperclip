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
  Rt2CaptureQueue,
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
  state: "queued" | "claimed" | "running" | "completed" | "failed" | "cancelled" | "blocked";
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
    reviewRequired: true;
  };
};

export type Rt2InboundDraftSource = "slack" | "teams" | "webhook" | "mobile" | "native";

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
  }) => api.post<Rt2InboundDraftResponse>(`/companies/${companyId}/rt2/one-liner/inbound-draft`, data),
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
  listCaptureQueue: (companyId: string) =>
    api.get<Rt2CaptureQueue>(`/companies/${companyId}/rt2/capture-drafts`),
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
  claimExecution: (attemptId: string, data: {
    executorType: "user" | "jarvis" | "runtime";
    executorId: string;
    executionWorkspaceId?: string | null;
    runtimeServiceId?: string | null;
    heartbeatRunId?: string | null;
  }) => api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/claim`, data),
  startExecution: (attemptId: string, data: { runtimeServiceId?: string | null; heartbeatRunId?: string | null } = {}) =>
    api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/start`, data),
  completeExecution: (attemptId: string, data: {
    resultWorkProductId?: string | null;
    missingDeliverableReason?: string | null;
  }) => api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/complete`, data),
  failExecution: (attemptId: string, data: { failureReason: string }) =>
    api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/fail`, data),
  retryExecution: (attemptId: string) =>
    api.post<Rt2ExecutionSummary>(`/rt2/executions/${encodeURIComponent(attemptId)}/retry`, {}),
  endParticipant: (taskIssueId: string, userId: string, reason: EndRt2Participant["reason"]) =>
    api.post<Rt2EndParticipantResponse>(
      `/rt2/tasks/${encodeURIComponent(taskIssueId)}/participants/${encodeURIComponent(userId)}/end`,
      { reason },
    ),
};
