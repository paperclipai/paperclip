import type { QueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

const ISSUE_DETAIL_QUERY_PREFIX = ["issues", "detail"] as const;
export const ISSUE_DETAIL_STALE_TIME_MS = 60_000;

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
  const issue = await issuesApi.get(issueRef);
  return seedIssueDetailCache(queryClient, issue, { issueRef });
}

export function prefetchIssueDetail(
  queryClient: QueryClient,
  issueRef: string,
  options?: {
    issue?: Issue | null;
  },
) {
  if (options?.issue) {
    seedIssueDetailCache(queryClient, options.issue, { issueRef });
  }

  return queryClient.prefetchQuery({
    queryKey: queryKeys.issues.detail(issueRef),
    queryFn: () => fetchIssueDetail(queryClient, issueRef),
    staleTime: ISSUE_DETAIL_STALE_TIME_MS,
  });
}
