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
export type LocallyQueuedIssueComment<T extends IssueComment> = T & {
  clientStatus: "queued";
  queueState: "queued";
  queueTargetRunId: string;
};

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

function sortIssueCommentsDesc<T extends { createdAt: Date | string; id: string }>(comments: T[]) {
  return sortIssueComments(comments).reverse();
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
  comment: Pick<IssueTimelineComment, "createdAt"> &
    Partial<Pick<OptimisticIssueComment, "clientStatus">> & {
      authorAgentId?: string | null;
    };
  activeRunStartedAt?: Date | string | null;
  activeRunAgentId?: string | null;
  runId?: string | null;
  interruptedRunId?: string | null;
}) {
  if (params.runId) return false;
  if (params.interruptedRunId) return false;
  if (params.comment.authorAgentId && params.activeRunAgentId && params.comment.authorAgentId === params.activeRunAgentId) {
    return false;
  }
  if (params.comment.clientStatus === "queued") return true;
  if (!params.activeRunStartedAt) return false;
  return toTimestamp(params.comment.createdAt) >= toTimestamp(params.activeRunStartedAt);
}

export function applyLocalQueuedIssueCommentState<T extends IssueComment>(
  comment: T,
  params: {
    queuedTargetRunId?: string | null;
    targetRunIsLive: boolean;
    runningRunId?: string | null;
  },
): T | LocallyQueuedIssueComment<T> {
  const queuedTargetRunId = params.queuedTargetRunId ?? null;
  if (!queuedTargetRunId || !params.targetRunIsLive) return comment;
  if (params.runningRunId && params.runningRunId !== queuedTargetRunId) return comment;

  return {
    ...comment,
    clientStatus: "queued",
    queueState: "queued",
    queueTargetRunId: queuedTargetRunId,
  };
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

export function takeOptimisticIssueComment(
  comments: OptimisticIssueComment[],
  clientId: string,
): { comments: OptimisticIssueComment[]; comment: OptimisticIssueComment | null } {
  const index = comments.findIndex((comment) => comment.clientId === clientId);
  if (index === -1) {
    return { comments, comment: null };
  }

  return {
    comments: comments.filter((comment) => comment.clientId !== clientId),
    comment: comments[index] ?? null,
  };
}

export function flattenIssueCommentPages(
  pages: ReadonlyArray<ReadonlyArray<IssueComment>> | undefined,
): IssueComment[] {
  return sortIssueComments((pages ?? []).flatMap((page) => page));
}

export function getNextIssueCommentPageParam(
  lastPage: ReadonlyArray<IssueComment> | undefined,
  pageSize: number,
): string | undefined {
  if (!lastPage || lastPage.length < pageSize) return undefined;
  return lastPage[lastPage.length - 1]?.id;
}

function getNextPageCursor<T extends { id: string }>(
  lastPage: ReadonlyArray<T> | undefined,
  pageSize: number,
): string | undefined {
  if (!lastPage || lastPage.length < pageSize) return undefined;
  return lastPage[lastPage.length - 1]?.id;
}

export async function loadRemainingIssueCommentPages<T extends { id: string }>(params: {
  pages: ReadonlyArray<ReadonlyArray<T>> | undefined;
  pageParams: ReadonlyArray<string | null> | undefined;
  pageSize: number;
  maxPages?: number;
  fetchPage: (afterCommentId: string) => Promise<ReadonlyArray<T>>;
}): Promise<{ pages: T[][]; pageParams: Array<string | null> }> {
  const pages = (params.pages ?? []).map((page) => [...page]);
  const pageParams = params.pageParams
    ? [...params.pageParams].slice(0, pages.length)
    : pages.map(() => null);

  while (pageParams.length < pages.length) {
    pageParams.push(null);
  }

  if (params.pageSize <= 0) return { pages, pageParams };

  let cursor = getNextPageCursor(pages[pages.length - 1], params.pageSize);
  const maxPages = Math.max(0, params.maxPages ?? Number.POSITIVE_INFINITY);
  const seenCursors = new Set<string>();
  while (cursor && !seenCursors.has(cursor) && seenCursors.size < maxPages) {
    seenCursors.add(cursor);
    const nextPage = [...await params.fetchPage(cursor)];
    pages.push(nextPage);
    pageParams.push(cursor);

    cursor = getNextPageCursor(nextPage, params.pageSize);
  }

  return { pages, pageParams };
}

export function shouldAutoloadOlderIssueComments(params: {
  activeDetailTab: string;
  hasOlderComments: boolean;
  loadedCommentCount: number;
  initialPageLoading: boolean;
  olderPageLoading: boolean;
  autoLoadLimit: number;
}) {
  if (params.activeDetailTab !== "chat") return false;
  if (!params.hasOlderComments) return false;
  if (params.initialPageLoading || params.olderPageLoading) return false;
  if (params.loadedCommentCount === 0) return false;
  return params.loadedCommentCount < params.autoLoadLimit;
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

  if (params.reopen === true && (issue.status === "done" || issue.status === "cancelled" || issue.status === "blocked")) {
    nextIssue.status = "todo";
  }

  if (params.reassignment) {
    nextIssue.assigneeAgentId = params.reassignment.assigneeAgentId;
    nextIssue.assigneeUserId = params.reassignment.assigneeUserId;
  }

  return nextIssue;
}

export function applyOptimisticIssueFieldUpdate(
  issue: Issue | undefined,
  data: Record<string, unknown>,
) {
  if (!issue) return issue;

  const nextIssue: Issue = {
    ...issue,
    updatedAt: new Date(),
  };
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(data, key);
  const assign = <K extends keyof Issue>(key: K) => {
    if (hasOwn(key)) {
      nextIssue[key] = data[key] as Issue[K];
    }
  };

  assign("status");
  assign("priority");
  assign("assigneeAgentId");
  assign("assigneeUserId");
  assign("projectId");
  assign("parentId");
  assign("projectWorkspaceId");
  assign("executionWorkspaceId");
  assign("executionWorkspacePreference");
  assign("executionWorkspaceSettings");
  assign("hiddenAt");

  if (hasOwn("labelIds") && Array.isArray(data.labelIds)) {
    const nextLabelIds = data.labelIds.filter((value): value is string => typeof value === "string");
    nextIssue.labelIds = nextLabelIds;
    if (issue.labels) {
      nextIssue.labels = issue.labels.filter((label) => nextLabelIds.includes(label.id));
    }
  }

  if (hasOwn("blockedByIssueIds") && Array.isArray(data.blockedByIssueIds) && issue.blockedBy) {
    const nextBlockedByIds = new Set(
      data.blockedByIssueIds.filter((value): value is string => typeof value === "string"),
    );
    nextIssue.blockedBy = issue.blockedBy.filter((relation) => nextBlockedByIds.has(relation.id));
  }

  if (hasOwn("projectId")) {
    nextIssue.project = issue.project?.id === nextIssue.projectId ? issue.project : null;
  }

  if (hasOwn("parentId")) {
    nextIssue.ancestors = undefined;
  }

  if (hasOwn("executionWorkspaceId")) {
    nextIssue.currentExecutionWorkspace =
      issue.currentExecutionWorkspace?.id === nextIssue.executionWorkspaceId
        ? issue.currentExecutionWorkspace
        : null;
  }

  return nextIssue;
}

export function matchesIssueRef(
  issue: Pick<Issue, "id" | "identifier">,
  refs: Iterable<string>,
) {
  const refSet = refs instanceof Set ? refs : new Set(refs);
  return refSet.has(issue.id) || (!!issue.identifier && refSet.has(issue.identifier));
}

export function applyOptimisticIssueFieldUpdateToCollection(
  issues: Issue[] | undefined,
  refs: Iterable<string>,
  data: Record<string, unknown>,
) {
  if (!issues) return issues;

  let changed = false;
  const nextIssues = issues.map((issue) => {
    if (!matchesIssueRef(issue, refs)) return issue;
    changed = true;
    return applyOptimisticIssueFieldUpdate(issue, data) ?? issue;
  });

  return changed ? nextIssues : issues;
}

export function upsertIssueCommentInPages(
  pages: ReadonlyArray<ReadonlyArray<IssueComment>> | undefined,
  nextComment: IssueComment,
): IssueComment[][] {
  if (!pages || pages.length === 0) {
    return [[nextComment]];
  }

  const nextPages = pages.map((page) => [...page]);
  for (let pageIndex = 0; pageIndex < nextPages.length; pageIndex += 1) {
    const existingIndex = nextPages[pageIndex]!.findIndex((comment) => comment.id === nextComment.id);
    if (existingIndex === -1) continue;
    nextPages[pageIndex]![existingIndex] = nextComment;
    nextPages[pageIndex] = sortIssueCommentsDesc(nextPages[pageIndex]!);
    return nextPages;
  }

  nextPages[0] = sortIssueCommentsDesc([...nextPages[0]!, nextComment]);
  return nextPages;
}

export function removeIssueCommentFromPages(
  pages: ReadonlyArray<ReadonlyArray<IssueComment>> | undefined,
  commentId: string,
): IssueComment[][] {
  if (!pages || pages.length === 0) {
    return [];
  }

  return pages
    .map((page) => page.filter((comment) => comment.id !== commentId))
    .filter((page) => page.length > 0);
}
