import type { Issue, IssueComment } from "@paperclipai/shared";

export interface IssueCommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface OptimisticIssueComment extends IssueComment {
  clientId: string;
  clientStatus: "pending" | "queued";
  queueTargetRunId?: string | null;
}

export type IssueTimelineComment = IssueComment | OptimisticIssueComment;

function toTimestamp(value: Date | string) {
  return new Date(value).getTime();
}

function createOptimisticCommentId() {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return `optimistic-${randomUuid}`;
  }
  return `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sortIssueComments<T extends { createdAt: Date | string; id: string }>(comments: T[]) {
  return [...comments].sort((a, b) => {
    const createdAtDiff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    if (createdAtDiff !== 0) return createdAtDiff;
    return a.id.localeCompare(b.id);
  });
}

export function createOptimisticIssueComment(params: {
  companyId: string;
  issueId: string;
  body: string;
  authorUserId: string | null;
  clientStatus?: OptimisticIssueComment["clientStatus"];
  queueTargetRunId?: string | null;
}): OptimisticIssueComment {
  const now = new Date();
  const clientId = createOptimisticCommentId();
  return {
    id: clientId,
    clientId,
    companyId: params.companyId,
    issueId: params.issueId,
    authorAgentId: null,
    authorUserId: params.authorUserId,
    body: params.body,
    clientStatus: params.clientStatus ?? "pending",
    queueTargetRunId: params.queueTargetRunId ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function isQueuedIssueComment(params: {
  comment: Pick<IssueTimelineComment, "createdAt"> & Partial<Pick<OptimisticIssueComment, "clientStatus">>;
  activeRunStartedAt?: Date | string | null;
  runId?: string | null;
  interruptedRunId?: string | null;
}) {
  if (params.runId) return false;
  if (params.interruptedRunId) return false;
  if (params.comment.clientStatus === "queued") return true;
  if (!params.activeRunStartedAt) return false;
  return toTimestamp(params.comment.createdAt) >= toTimestamp(params.activeRunStartedAt);
}

export function mergeIssueComments(
  comments: IssueComment[] | undefined,
  optimisticComments: OptimisticIssueComment[],
): IssueTimelineComment[] {
  const merged = [...(comments ?? [])];
  const existingIds = new Set(merged.map((comment) => comment.id));
  for (const comment of optimisticComments) {
    if (!existingIds.has(comment.id)) {
      merged.push(comment);
    }
  }
  return sortIssueComments(merged);
}

export function upsertIssueComment(
  comments: IssueComment[] | undefined,
  nextComment: IssueComment,
): IssueComment[] {
  const current = comments ?? [];
  const existingIndex = current.findIndex((comment) => comment.id === nextComment.id);
  if (existingIndex === -1) {
    return sortIssueComments([...current, nextComment]);
  }

  const updated = [...current];
  updated[existingIndex] = nextComment;
  return sortIssueComments(updated);
}

export function applyOptimisticIssueCommentUpdate(
  issue: Issue | undefined,
  params: {
    reopen?: boolean;
    reassignment?: IssueCommentReassignment;
  },
) {
  if (!issue) return issue;
  const nextIssue: Issue = { ...issue };

  if (params.reopen === true && (issue.status === "done" || issue.status === "cancelled")) {
    nextIssue.status = "todo";
  }

  if (params.reassignment) {
    nextIssue.assigneeAgentId = params.reassignment.assigneeAgentId;
    nextIssue.assigneeUserId = params.reassignment.assigneeUserId;
  }

  return nextIssue;
}
