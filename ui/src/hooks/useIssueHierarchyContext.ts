import { loadIssueHierarchyChildren } from "../lib/issue-hierarchy-context";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

export function useIssueHierarchyContext(companyId: string | null, matches: Issue[], collapsedParents: string[], enabled: boolean, rowBudget: number) {
  const parents = [...new Set(matches.map((issue) => issue.parentId).filter((id): id is string => Boolean(id)))];
  const ancestorQueries = useQueries({ queries: parents.map((parentId) => ({
    queryKey: [...queryKeys.issues.list(companyId ?? "__unscoped__"), "hierarchy-ancestors", parentId],
    enabled: enabled && Boolean(companyId),
    staleTime: 30_000,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const ancestors: Issue[] = [];
      const visited = new Set<string>();
      let id: string | null = parentId;
      while (id && !visited.has(id)) {
        visited.add(id);
        try {
          const parent: Issue = await issuesApi.get(id, { signal });
          if (parent.companyId !== companyId) break;
          ancestors.push(parent);
          id = parent.parentId;
        } catch (error) {
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) break;
          throw error;
        }
      }
      return ancestors;
    },
  })) });
  const children = useQuery<Awaited<ReturnType<typeof loadIssueHierarchyChildren>>>({
    queryKey: [...queryKeys.issues.list(companyId ?? "__unscoped__"), "hierarchy-children", matches.map((issue) => issue.id), collapsedParents, rowBudget],
    enabled: enabled && Boolean(companyId) && matches.length > 0,
    staleTime: 30_000,
    placeholderData: (previous) => previous ? {
      ...previous, issues: previous.issues.filter((issue) => issue.companyId === companyId),
    } : undefined,
    queryFn: ({ signal }) => loadIssueHierarchyChildren(companyId!, matches, collapsedParents, rowBudget,
      (parentId, limit, offset) => issuesApi.list(companyId!, { parentId, limit, offset, includeRoutineExecutions: true }, { signal })),
  });
  const queries = [...ancestorQueries, children];
  return {
    issues: [...ancestorQueries.flatMap((query) => query.data ?? []), ...(children.data?.issues ?? [])],
    hasMore: children.data?.hasMore ?? false,
    isFetching: children.isFetching,
    error: queries.find((query) => query.error)?.error,
  };
}
