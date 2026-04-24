import type {
  Approval,
  DocumentRevision,
  FeedbackTargetType,
  FeedbackTrace,
  FeedbackVote,
  IssueListSort,
  Issue,
  IssueStatus,
  IssueActionRequest,
  IssueActionResult,
  IssueAttachment,
  IssueComment,
  IssueDocument,
  IssueFilePreview,
  IssueLabel,
  IssueWorkProduct,
  UpsertIssueDocument,
} from "@paperclipai/shared";
import { api } from "./client";

export type IssueWakeupWarning = {
  code: string;
  message: string;
  reason?: string;
  agentId?: string;
};

export type IssueUpdateResponse = Issue & {
  comment?: IssueComment | null;
  warnings?: IssueWakeupWarning[];
};

export type WorkflowAwareIssueUpdateResponse = IssueUpdateResponse | IssueActionResult;

const WORKFLOW_AWARE_UPDATE_KEYS = new Set(["status", "comment"]);
const OPEN_ISSUE_STATUSES = new Set<IssueStatus>(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const CLOSED_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);

function toTrimmedOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isOpenIssueStatus(status: IssueStatus | null | undefined): status is IssueStatus {
  return Boolean(status && OPEN_ISSUE_STATUSES.has(status));
}

function isClosedIssueStatus(status: IssueStatus | null | undefined): status is IssueStatus {
  return Boolean(status && CLOSED_ISSUE_STATUSES.has(status));
}

function toIssueUpdateResponseFromAction(result: IssueActionResult): IssueUpdateResponse {
  return {
    ...result.issue,
    comment: result.comment,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
}

export function resolveIssueActionForWorkflowAwareUpdate(
  currentStatus: IssueStatus | null | undefined,
  data: Record<string, unknown>,
): IssueActionRequest | null {
  const keys = Object.keys(data);
  if (keys.length === 0 || keys.some((key) => !WORKFLOW_AWARE_UPDATE_KEYS.has(key))) {
    return null;
  }

  const nextStatus = typeof data.status === "string" ? data.status : null;
  if (!nextStatus) {
    return null;
  }

  const commentBody = toTrimmedOptionalString(data.comment);

  // Only emit typed actions when the current state is known enough to map the
  // transition unambiguously. Otherwise fall back to PATCH so the server can
  // enforce the full status transition matrix.
  if (OPEN_ISSUE_STATUSES.has(nextStatus as IssueStatus) && isClosedIssueStatus(currentStatus)) {
    return {
      type: "reopen_issue",
      payload: {
        status: nextStatus as Extract<IssueStatus, "backlog" | "todo" | "in_progress" | "in_review" | "blocked">,
        ...(commentBody ? { body: commentBody } : {}),
      },
    };
  }

  if (nextStatus === "done" && isOpenIssueStatus(currentStatus)) {
    return {
      type: "complete_issue",
      payload: {
        ...(commentBody ? { body: commentBody } : {}),
      },
    };
  }

  if (nextStatus === "in_review" && isOpenIssueStatus(currentStatus) && currentStatus !== "in_review") {
    return {
      type: "enter_review",
      payload: {
        ...(commentBody ? { body: commentBody } : {}),
      },
    };
  }

  return null;
}

export const issuesApi = {
  list: (
    companyId: string,
    filters?: {
      status?: string;
      ids?: string[];
      sort?: IssueListSort;
      projectId?: string;
      assigneeAgentId?: string;
      participantAgentId?: string;
      assigneeUserId?: string;
      touchedByUserId?: string;
      inboxArchivedByUserId?: string;
      unreadForUserId?: string;
      labelId?: string;
      executionWorkspaceId?: string;
      originKind?: string;
      originId?: string;
      includeRoutineExecutions?: boolean;
      includeClosed?: boolean;
      includeRelations?: boolean;
      includeReviewSignals?: boolean;
      excludeRecoverySourcesWithOpenSuccessors?: boolean;
      q?: string;
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.ids && filters.ids.length > 0) params.set("ids", filters.ids.join(","));
    if (filters?.sort) params.set("sort", filters.sort);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.assigneeAgentId) params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters?.participantAgentId) params.set("participantAgentId", filters.participantAgentId);
    if (filters?.assigneeUserId) params.set("assigneeUserId", filters.assigneeUserId);
    if (filters?.touchedByUserId) params.set("touchedByUserId", filters.touchedByUserId);
    if (filters?.inboxArchivedByUserId) params.set("inboxArchivedByUserId", filters.inboxArchivedByUserId);
    if (filters?.unreadForUserId) params.set("unreadForUserId", filters.unreadForUserId);
    if (filters?.labelId) params.set("labelId", filters.labelId);
    if (filters?.executionWorkspaceId) params.set("executionWorkspaceId", filters.executionWorkspaceId);
    if (filters?.originKind) params.set("originKind", filters.originKind);
    if (filters?.originId) params.set("originId", filters.originId);
    if (filters?.includeRoutineExecutions) params.set("includeRoutineExecutions", "true");
    if (filters?.includeClosed) params.set("includeClosed", "true");
    if (filters?.includeRelations) params.set("includeRelations", "true");
    if (filters?.includeReviewSignals) params.set("includeReviewSignals", "true");
    if (filters?.excludeRecoverySourcesWithOpenSuccessors) {
      params.set("excludeRecoverySourcesWithOpenSuccessors", "true");
    }
    if (filters?.q) params.set("q", filters.q);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<Issue[]>(`/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
  },
  listLabels: (companyId: string) => api.get<IssueLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: { name: string; color: string }) =>
    api.post<IssueLabel>(`/companies/${companyId}/labels`, data),
  deleteLabel: (id: string) => api.delete<IssueLabel>(`/labels/${id}`),
  get: (id: string) => api.get<Issue>(`/issues/${id}`),
  markRead: (id: string) => api.post<{ id: string; lastReadAt: Date }>(`/issues/${id}/read`, {}),
  markUnread: (id: string) => api.delete<{ id: string; removed: boolean }>(`/issues/${id}/read`),
  archiveFromInbox: (id: string) =>
    api.post<{ id: string; archivedAt: Date }>(`/issues/${id}/inbox-archive`, {}),
  unarchiveFromInbox: (id: string) =>
    api.delete<{ id: string; archivedAt: Date } | { ok: true }>(`/issues/${id}/inbox-archive`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<IssueUpdateResponse>(`/companies/${companyId}/issues`, data),
  applyWorkflowTemplate: (id: string, data: { workflowTemplateKey: string }) =>
    api.post<Issue>(`/issues/${id}/apply-workflow-template`, data),
  archiveClosed: (companyId: string, input?: { olderThanDays?: number }) =>
    api.post<{
      archivedCount: number;
      issueIds: string[];
      olderThanDays: number;
      archivedAt: string;
      cutoff: string;
    }>(`/companies/${companyId}/issues/archive-closed`, input ?? {}),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<IssueUpdateResponse>(`/issues/${id}`, data),
  act: (id: string, data: IssueActionRequest) =>
    api.post<IssueActionResult>(`/issues/${id}/actions`, data),
  updateWorkflowAware: (
    id: string,
    currentStatus: IssueStatus | null | undefined,
    data: Record<string, unknown>,
  ) => {
    const action = resolveIssueActionForWorkflowAwareUpdate(currentStatus, data);
    if (action) {
      return issuesApi.act(id, action);
    }
    return issuesApi.update(id, data);
  },
  remove: (id: string) => api.delete<Issue>(`/issues/${id}`),
  checkout: (id: string, agentId: string) =>
    api.post<Issue>(`/issues/${id}/checkout`, {
      agentId,
      expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
    }),
  release: (id: string) => api.post<Issue>(`/issues/${id}/release`, {}),
  listComments: (
    id: string,
    opts?: {
      afterCommentId?: string | null;
      order?: "asc" | "desc";
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (opts?.afterCommentId) params.set("afterCommentId", opts.afterCommentId);
    if (opts?.order) params.set("order", opts.order);
    if (opts?.limit && Number.isFinite(opts.limit) && opts.limit > 0) {
      params.set("limit", String(Math.floor(opts.limit)));
    }
    const qs = params.toString();
    return api.get<IssueComment[]>(`/issues/${id}/comments${qs ? `?${qs}` : ""}`);
  },
  listFeedbackVotes: (id: string) => api.get<FeedbackVote[]>(`/issues/${id}/feedback-votes`),
  listFeedbackTraces: (id: string, filters?: Record<string, string | boolean | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return api.get<FeedbackTrace[]>(`/issues/${id}/feedback-traces${qs ? `?${qs}` : ""}`);
  },
  upsertFeedbackVote: (
    id: string,
    data: {
      targetType: FeedbackTargetType;
      targetId: string;
      vote: "up" | "down";
      reason?: string;
      allowSharing?: boolean;
    },
  ) => api.post<FeedbackVote>(`/issues/${id}/feedback-votes`, data),
  addComment: (id: string, body: string, reopen?: boolean, interrupt?: boolean) =>
    api.post<IssueComment>(
      `/issues/${id}/comments`,
      {
        body,
        ...(reopen === undefined ? {} : { reopen }),
        ...(interrupt === undefined ? {} : { interrupt }),
      },
    ),
  addCommentWorkflowAware: async (
    id: string,
    currentStatus: IssueStatus | null | undefined,
    body: string,
    reopen?: boolean,
    interrupt?: boolean,
  ) => {
    const shouldReopenClosedIssue = reopen === true && isClosedIssueStatus(currentStatus);
    if (shouldReopenClosedIssue) {
      if (interrupt) {
        throw new Error("Interrupt cannot be combined with typed reopen comments.");
      }
      const result = await issuesApi.act(id, {
        type: "reopen_issue",
        payload: { body },
      });
      if (!result.comment) {
        throw new Error("Typed reopen_issue did not create an issue comment.");
      }
      return result.comment;
    }
    return issuesApi.addComment(id, body, undefined, interrupt);
  },
  addCommentAndReassignWorkflowAware: async (
    id: string,
    currentStatus: IssueStatus | null | undefined,
    input: {
      body: string;
      reopen?: boolean;
      interrupt?: boolean;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
    },
  ) => {
    const shouldReopenClosedIssue = input.reopen === true && isClosedIssueStatus(currentStatus);
    if (shouldReopenClosedIssue) {
      if (input.interrupt) {
        throw new Error("Interrupt cannot be combined with typed handoff comments.");
      }
      const result = await issuesApi.act(id, {
        type: "handoff_issue",
        payload: {
          body: input.body,
          reopen: true,
          ...(input.assigneeAgentId === undefined ? {} : { assigneeAgentId: input.assigneeAgentId }),
          ...(input.assigneeUserId === undefined ? {} : { assigneeUserId: input.assigneeUserId }),
        },
      });
      return toIssueUpdateResponseFromAction(result);
    }
    return issuesApi.update(id, {
      comment: input.body,
      ...(input.assigneeAgentId === undefined ? {} : { assigneeAgentId: input.assigneeAgentId }),
      ...(input.assigneeUserId === undefined ? {} : { assigneeUserId: input.assigneeUserId }),
      ...(input.interrupt ? { interrupt: input.interrupt } : {}),
    });
  },
  listDocuments: (id: string) => api.get<IssueDocument[]>(`/issues/${id}/documents`),
  getDocument: (id: string, key: string) => api.get<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
  upsertDocument: (id: string, key: string, data: UpsertIssueDocument) =>
    api.put<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`, data),
  listDocumentRevisions: (id: string, key: string) =>
    api.get<DocumentRevision[]>(`/issues/${id}/documents/${encodeURIComponent(key)}/revisions`),
  restoreDocumentRevision: (id: string, key: string, revisionId: string) =>
    api.post<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}/revisions/${revisionId}/restore`, {}),
  deleteDocument: (id: string, key: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
  listAttachments: (id: string) => api.get<IssueAttachment[]>(`/issues/${id}/attachments`),
  getFilePreview: (id: string, path: string) =>
    api.get<IssueFilePreview>(`/issues/${id}/file-preview?${new URLSearchParams({ path }).toString()}`),
  uploadAttachment: (
    companyId: string,
    issueId: string,
    file: File,
    issueCommentId?: string | null,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (issueCommentId) {
      form.append("issueCommentId", issueCommentId);
    }
    return api.postForm<IssueAttachment>(`/companies/${companyId}/issues/${issueId}/attachments`, form);
  },
  deleteAttachment: (id: string) => api.delete<{ ok: true }>(`/attachments/${id}`),
  listApprovals: (id: string) => api.get<Approval[]>(`/issues/${id}/approvals`),
  linkApproval: (id: string, approvalId: string) =>
    api.post<Approval[]>(`/issues/${id}/approvals`, { approvalId }),
  unlinkApproval: (id: string, approvalId: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/approvals/${approvalId}`),
  listWorkProducts: (id: string) => api.get<IssueWorkProduct[]>(`/issues/${id}/work-products`),
  createWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.post<IssueWorkProduct>(`/issues/${id}/work-products`, data),
  updateWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.patch<IssueWorkProduct>(`/work-products/${id}`, data),
  deleteWorkProduct: (id: string) => api.delete<IssueWorkProduct>(`/work-products/${id}`),
};
