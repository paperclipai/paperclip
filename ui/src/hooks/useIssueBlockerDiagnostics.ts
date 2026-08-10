import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { IssueBlockerDiagnosticsResponse } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

/**
 * Load the read-only blocker diagnostics for a task so the next-action surface
 * can explain terminal gates (done-but-blocking / workspace-finalize-pending).
 * Only enabled for tasks that are actually blocked, to avoid needless fetches.
 */
export function useIssueBlockerDiagnostics(
  issueId: string | null | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<IssueBlockerDiagnosticsResponse, unknown> {
  const enabled = (options.enabled ?? true) && Boolean(issueId);
  return useQuery({
    queryKey: queryKeys.issues.blockerDiagnostics(issueId ?? "__none__"),
    queryFn: () => issuesApi.getBlockerDiagnostics(issueId as string),
    enabled,
    staleTime: 15_000,
  });
}
