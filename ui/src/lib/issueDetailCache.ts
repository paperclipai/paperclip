import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { Issue, IssueComment } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { getNextIssueCommentPageParam, ISSUE_COMMENT_PAGE_SIZE } from "@/lib/optimistic-issue-comments";

const ISSUE_DETAIL_QUERY_PREFIX = ["issues", "detail"] as const;
export const ISSUE_DETAIL_STALE_TIME_MS = 60_000;
/**
 * Freshness window for a prefetched first comments page. Matches the global
 * query staleTime so a warm navigation that arrives within the window renders
 * the seeded comments without an immediate refetch (no loading state), while a
 * later revisit still revalidates in the background.
 */
export const ISSUE_COMMENTS_PREFETCH_STALE_TIME_MS = 30_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function collectIssueRefs(
  issueRef: string | null | undefined,
  issue?: Pick<Issue, "id" | "identifier"> | null,
): string[] {
  const refs = new Set<string>();
  if (isNonEmptyString(issueRef)) refs.add(issueRef);
  if (isNonEmptyString(issue?.id)) refs.add(issue.id);
  if (isNonEmptyString(issue?.identifier)) refs.add(issue.identifier);
  return Array.from(refs);
}

function matchesIssueRef(issue: Pick<Issue, "id" | "identifier">, refs: Iterable<string>) {
  const refSet = refs instanceof Set ? refs : new Set(refs);
  return refSet.has(issue.id) || (!!issue.identifier && refSet.has(issue.identifier));
}

function isCompleteIssueSnapshot(value: unknown): value is Issue {
  if (typeof value !== "object" || value === null) return false;
  const issue = value as Partial<Issue>;
  return (
    isNonEmptyString(issue.id)
    && isNonEmptyString(issue.companyId)
    && typeof issue.title === "string"
    && typeof issue.status === "string"
    && typeof issue.workMode === "string"
    && typeof issue.priority === "string"
    && (issue.projectId === null || typeof issue.projectId === "string")
    && (issue.parentId === null || typeof issue.parentId === "string")
    && (issue.identifier === null || typeof issue.identifier === "string")
    && (issue.description === null || typeof issue.description === "string")
    && (issue.assigneeAgentId === null || typeof issue.assigneeAgentId === "string")
    && (issue.assigneeUserId === null || typeof issue.assigneeUserId === "string")
    && (issue.executionRunId === null || typeof issue.executionRunId === "string")
    && (issue.issueNumber === null || typeof issue.issueNumber === "number")
    && typeof issue.requestDepth === "number"
    && issue.createdAt != null
    && issue.updatedAt != null
  );
}

function mergeIssueSnapshots(existing: Issue | undefined, incoming: Issue): Issue {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
  };
}

export function getIssueDetailCacheRefs(issue: Pick<Issue, "id" | "identifier">): string[] {
  return collectIssueRefs(null, issue);
}

export function getCachedIssueDetail(
  queryClient: QueryClient,
  issueRef: string | null | undefined,
  issue?: Pick<Issue, "id" | "identifier"> | null,
): Issue | undefined {
  const refs = collectIssueRefs(issueRef, issue);

  for (const ref of refs) {
    const cached = queryClient.getQueryData<Issue>(queryKeys.issues.detail(ref));
    if (isCompleteIssueSnapshot(cached)) return cached;
  }

  const cachedEntries = queryClient.getQueriesData<Issue>({ queryKey: ISSUE_DETAIL_QUERY_PREFIX });
  return cachedEntries
    .map(([, cachedIssue]) => cachedIssue)
    .find((cachedIssue): cachedIssue is Issue =>
      isCompleteIssueSnapshot(cachedIssue) && matchesIssueRef(cachedIssue, refs)
    );
}

export function seedIssueDetailCache(
  queryClient: QueryClient,
  issue: Issue,
  options?: {
    issueRef?: string | null;
  },
): Issue {
  if (!isCompleteIssueSnapshot(issue)) return issue;

  const refs = collectIssueRefs(options?.issueRef, issue);
  const merged = mergeIssueSnapshots(getCachedIssueDetail(queryClient, options?.issueRef, issue), issue);

  for (const ref of refs) {
    queryClient.setQueryData<Issue>(
      queryKeys.issues.detail(ref),
      (existing) => mergeIssueSnapshots(existing, merged),
    );
  }

  return merged;
}

export async function fetchIssueDetail(
  queryClient: QueryClient,
  issueRef: string,
  options?: { signal?: AbortSignal },
): Promise<Issue> {
  const requestedAt = Date.now();
  const cachedIssueBeforeRequest = getCachedIssueDetail(queryClient, issueRef);
  const detailRefsBeforeRequest = collectIssueRefs(issueRef, cachedIssueBeforeRequest);
  const detailStateBeforeRequest = new Map(detailRefsBeforeRequest.map((ref) => {
    const queryKey = queryKeys.issues.detail(ref);
    return [ref, {
      data: queryClient.getQueryData<Issue>(queryKey),
      dataUpdatedAt: queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0,
    }] as const;
  }));
  const view = options ? await issuesApi.getView(issueRef, options) : await issuesApi.getView(issueRef);
  const refs = collectIssueRefs(issueRef, view.detail);
  const invalidatedLiveIssue = refs
    .map((ref) => {
      const queryKey = queryKeys.issues.detail(ref);
      const data = queryClient.getQueryData<Issue>(queryKey);
      return queryClient.getQueryState(queryKey)?.isInvalidated && isCompleteIssueSnapshot(data)
        ? data
        : null;
    })
    .find((data): data is Issue => data !== null);
  const freshestLiveIssue = refs
    .map((ref) => {
      const queryKey = queryKeys.issues.detail(ref);
      const data = queryClient.getQueryData<Issue>(queryKey);
      const dataUpdatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
      const before = detailStateBeforeRequest.get(ref);
      const changedDuringRequest = data !== before?.data || dataUpdatedAt !== (before?.dataUpdatedAt ?? 0);
      return isCompleteIssueSnapshot(data) && changedDuringRequest && dataUpdatedAt >= requestedAt
        ? { data, dataUpdatedAt }
        : null;
    })
    .filter((entry): entry is { data: Issue; dataUpdatedAt: number } => entry !== null)
    .sort((left, right) => right.dataUpdatedAt - left.dataUpdatedAt)[0]?.data;
  const issue = seedIssueDetailCache(
    queryClient,
    invalidatedLiveIssue ?? freshestLiveIssue ?? view.detail,
    { issueRef },
  );
  const hydrateIfNotUpdatedDuringRequest = <T>(queryKey: readonly unknown[], value: T) => {
    const state = queryClient.getQueryState(queryKey);
    if (state?.isInvalidated || (state?.dataUpdatedAt ?? 0) >= requestedAt) return;
    queryClient.setQueryData(queryKey, value);
  };
  for (const ref of refs) {
    hydrateIfNotUpdatedDuringRequest<InfiniteData<typeof view.comments, string | null>>(
      queryKeys.issues.comments(ref),
      { pages: [view.comments], pageParams: [null] },
    );
    hydrateIfNotUpdatedDuringRequest(queryKeys.issues.interactions(ref), view.interactions);
    hydrateIfNotUpdatedDuringRequest(queryKeys.issues.attachments(ref), view.attachments);
    hydrateIfNotUpdatedDuringRequest(queryKeys.issues.workProducts(ref), view.workProducts);
    hydrateIfNotUpdatedDuringRequest(queryKeys.issues.runs(ref), view.runs);
    hydrateIfNotUpdatedDuringRequest(queryKeys.issues.liveRuns(ref), view.liveRuns);
    hydrateIfNotUpdatedDuringRequest(queryKeys.issues.activeRun(ref), view.activeRun);
  }
  hydrateIfNotUpdatedDuringRequest(
    queryKeys.issues.listByDescendantRoot(issue.companyId, issue.id),
    view.childIssues,
  );
  return issue;
}

export function getIssueDetailQueryOptions(
  queryClient: QueryClient,
  issueRef: string,
  options?: {
    placeholderIssue?: Pick<Issue, "id" | "identifier"> | null;
  },
) {
  return {
    queryKey: queryKeys.issues.detail(issueRef),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetchIssueDetail(queryClient, issueRef, { signal }),
    placeholderData: getCachedIssueDetail(queryClient, issueRef, options?.placeholderIssue ?? undefined),
  };
}

export function prefetchIssueDetail(
  queryClient: QueryClient,
  issueRef: string,
  options?: {
    issue?: Issue | null;
  },
) {
  if (isCompleteIssueSnapshot(options?.issue)) {
    seedIssueDetailCache(queryClient, options.issue, { issueRef });
  }

  return queryClient.prefetchQuery({
    queryKey: queryKeys.issues.detail(issueRef),
    queryFn: () => fetchIssueDetail(queryClient, issueRef),
    staleTime: ISSUE_DETAIL_STALE_TIME_MS,
  });
}

/**
 * Warm the first page of the issue-detail comment feed under the exact infinite
 * query key IssueDetail mounts, so a subsequent navigation paints comments from
 * cache instead of waiting on a fetch. Keyed by issue ref and always background
 * revalidated by the mounted query, so it never surfaces stale cross-issue data.
 *
 * `prefetchInfiniteQuery` respects `staleTime`: if the comments cache is already
 * fresh (e.g. seeded by the aggregate `getView` fetch), this is a no-op and does
 * not issue a redundant request.
 */
export function prefetchIssueComments(queryClient: QueryClient, issueRef: string) {
  return queryClient.prefetchInfiniteQuery({
    queryKey: queryKeys.issues.comments(issueRef),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      issuesApi.listComments(issueRef, {
        order: "desc",
        limit: ISSUE_COMMENT_PAGE_SIZE,
        ...(pageParam ? { after: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: IssueComment[]) =>
      getNextIssueCommentPageParam(lastPage, ISSUE_COMMENT_PAGE_SIZE),
    staleTime: ISSUE_COMMENTS_PREFETCH_STALE_TIME_MS,
    pages: 1,
  });
}

/**
 * Prefetch everything the issue-detail first paint needs — the detail snapshot
 * and the first comments page — for instant warm navigation from a list row.
 * Seeds the full list-row snapshot when provided so the header + description
 * paint immediately with no loading state.
 */
export function prefetchIssueDetailForNavigation(
  queryClient: QueryClient,
  issueRef: string,
  options?: {
    issue?: Issue | null;
  },
) {
  return Promise.all([
    prefetchIssueDetail(queryClient, issueRef, options),
    prefetchIssueComments(queryClient, issueRef),
  ]);
}
