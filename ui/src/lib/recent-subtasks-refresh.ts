import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

type Child = { id: string; parentId?: string | null; companyId: string };

/** Parent hints are separately authorized by live delivery, never raw details. */
export function refreshRecentSubtasks(
  client: QueryClient,
  companyId: string,
  issueId: string | null,
  parentIds: readonly string[] = [],
  viewerId?: string | null,
) {
  const parents = new Set(parentIds);
  if (issueId) parents.add(issueId);
  for (const query of client.getQueryCache().findAll({
    queryKey: [...queryKeys.issues.list(companyId), "recent-subtasks"],
  })) {
    if (viewerId !== undefined && query.queryKey[3] !== (viewerId ?? "__local_board__")) continue;
    const data = query.state.data as InfiniteData<Child[]> | undefined;
    if (parents.has(String(query.queryKey[4])) || data?.pages?.some(page =>
      Array.isArray(page) && page.some(child => child.companyId === companyId && child.id === issueId))) {
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true });
    }
  }
}

export function refreshRecentTaskSummaries(
  client: QueryClient, companyId: string, issueId: string | null,
  parentIds: readonly string[] | undefined,
) {
  // Old servers have no parent hints. Keep their summary fallback, while
  // current servers identify new children even outside every cached page.
  if (!parentIds) {
    void client.invalidateQueries({ queryKey: queryKeys.issues.summaries(companyId) });
    return;
  }
  const affected = new Set(parentIds);
  if (issueId) affected.add(issueId);
  const batches = client.getQueryCache().findAll({ queryKey: queryKeys.issues.summaries(companyId) });
  for (const batch of batches) {
    const rows = batch.state.data;
    if (Array.isArray(rows)) for (const row of rows) {
      if (row.companyId === companyId && row.id === issueId && typeof row.parentId === "string") affected.add(row.parentId);
    }
  }
  for (const batch of batches) {
    const ids = batch.queryKey[4];
    if (Array.isArray(ids) && ids.some(id => affected.has(id))) {
      void client.invalidateQueries({ queryKey: batch.queryKey, exact: true });
    }
  }
}
