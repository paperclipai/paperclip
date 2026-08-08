import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { IssueSubtreeDiagnosticsResponse } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

/**
 * Load the read-only subtree / blocker diagnostics for a task so the Next Action
 * panel can render a compact per-node verdict (Phase 4 UX spec §5). Only enabled
 * when there is a subtree worth scanning, to avoid needless fetches.
 */
export function useIssueSubtreeDiagnostics(
  issueId: string | null | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<IssueSubtreeDiagnosticsResponse, unknown> {
  const enabled = (options.enabled ?? true) && Boolean(issueId);
  return useQuery({
    queryKey: queryKeys.issues.subtreeDiagnostics(issueId ?? "__none__"),
    queryFn: () => issuesApi.getSubtreeDiagnostics(issueId as string),
    enabled,
    staleTime: 15_000,
  });
}
