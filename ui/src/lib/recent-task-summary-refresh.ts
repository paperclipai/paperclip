import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

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
