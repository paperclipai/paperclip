import type { QueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

const ISSUE_DETAIL_QUERY_PREFIX = ["issues", "detail"] as const;
export const ISSUE_DETAIL_STALE_TIME_MS = 60_000;

// Per-session negative cache of issue refs that resolved to a 404. Issue-mention
// prefetch fires GET /api/issues/<KEY> for every issue-key-like token it finds in
// a body; tokens for deleted / cross-company issues 404 and are re-fetched on every
// hover, which is the dominant slice of the board 404 storm (LUN-2659 / LUN-2660
// pattern 1). Remembering a known-404 ref lets us skip re-fetching it for the rest
// of the session. Cleared whenever the ref later resolves successfully (re-created).
const known404IssueRefs = new Set<string>();

/** Test-only: clear the per-session known-404 negative cache. */
export function resetIssueDetailNegativeCache(): void {
  known404IssueRefs.clear();
}

/** Whether an issue ref has been resolved as a 404 earlier this session. */
export function isKnown404IssueRef(issueRef: string): boolean {
  return known404IssueRefs.has(issueRef);
}

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
    if (cached) return cached;
  }

  const cachedEntries = queryClient.getQueriesData<Issue>({ queryKey: ISSUE_DETAIL_QUERY_PREFIX });
  return cachedEntries
    .map(([, cachedIssue]) => cachedIssue)
    .find((cachedIssue): cachedIssue is Issue => !!cachedIssue && matchesIssueRef(cachedIssue, refs));
}

export function seedIssueDetailCache(
  queryClient: QueryClient,
  issue: Issue,
  options?: {
    issueRef?: string | null;
  },
): Issue {
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
): Promise<Issue> {
  try {
    const issue = await issuesApi.get(issueRef);
    // A successful fetch clears any stale negative-cache entry (issue re-created).
    known404IssueRefs.delete(issueRef);
    return seedIssueDetailCache(queryClient, issue, { issueRef });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      known404IssueRefs.add(issueRef);
    }
    throw error;
  }
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
    queryFn: () => fetchIssueDetail(queryClient, issueRef),
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
  if (options?.issue) {
    // We already have the snapshot, so this ref is real — drop any stale 404 mark.
    known404IssueRefs.delete(issueRef);
    seedIssueDetailCache(queryClient, options.issue, { issueRef });
  } else if (known404IssueRefs.has(issueRef)) {
    // Don't re-fetch a mention key we already resolved as 404 this session.
    return Promise.resolve();
  }

  return queryClient.prefetchQuery({
    queryKey: queryKeys.issues.detail(issueRef),
    queryFn: () => fetchIssueDetail(queryClient, issueRef),
    staleTime: ISSUE_DETAIL_STALE_TIME_MS,
  });
}
