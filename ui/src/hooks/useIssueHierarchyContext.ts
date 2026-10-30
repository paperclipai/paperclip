import { loadIssueHierarchyChildren } from "../lib/issue-hierarchy-context";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

export function useIssueHierarchyContext(companyId: string | null, matches: Issue[], collapsedParents: string[], enabled: boolean, rowBudget: number) {
  const parents = [...new Set(matches.map((issue) => issue.parentId).filter((id): id is string => Boolean(id)))].sort();
  const ancestors = useQuery<Issue[]>({
    queryKey: [...queryKeys.issues.list(companyId ?? "__unscoped__"), "hierarchy-index-ancestors", parents],
    enabled: enabled && Boolean(companyId) && parents.length > 0,
    staleTime: 30_000,
    placeholderData: (previous) => previous?.filter((issue) => issue.companyId === companyId),
    queryFn: async ({ signal }) => {
      const rows: Issue[] = [];
      const visited = new Set<string>();
      let frontier = parents;
      while (frontier.length > 0) {
        const next: string[] = [];
        for (let offset = 0; offset < frontier.length; offset += 100) {
          const ids = frontier.slice(offset, offset + 100);
          ids.forEach((id) => visited.add(id));
          const batch = await issuesApi.listCompact(companyId!, { ids, projection: "index", limit: 100, includeRoutineExecutions: true }, { signal });
          for (const issue of batch) {
            if (issue.companyId !== companyId) continue;
            rows.push(issue as Issue);
            if (issue.parentId && !visited.has(issue.parentId)) next.push(issue.parentId);
          }
        }
        frontier = [...new Set(next)].filter((id) => !visited.has(id));
      }
      return rows;
    },
  });
  const children = useQuery<Awaited<ReturnType<typeof loadIssueHierarchyChildren>>>({
    queryKey: [...queryKeys.issues.list(companyId ?? "__unscoped__"), "hierarchy-index-children", matches.map((issue) => issue.id), collapsedParents, rowBudget],
    enabled: enabled && Boolean(companyId) && matches.length > 0,
    staleTime: 30_000,
    placeholderData: (previous) => previous ? {
      ...previous, issues: previous.issues.filter((issue) => issue.companyId === companyId),
    } : undefined,
    queryFn: ({ signal }) => loadIssueHierarchyChildren(companyId!, matches, collapsedParents, rowBudget,
      async (parentIds, limit, offset, oneChildPerParent) => await issuesApi.listCompact(companyId!, {
        parentIds, oneChildPerParent, projection: "index", limit, offset, includeRoutineExecutions: true,
      }, { signal }) as Issue[]),
  });
  return {
    issues: [...(ancestors.data ?? []), ...(children.data?.issues ?? [])],
    hasMore: children.data?.hasMore ?? false,
    isLoading: ancestors.isLoading || children.isLoading,
    isFetching: ancestors.isFetching || children.isFetching,
    error: ancestors.error ?? children.error,
  };
}
