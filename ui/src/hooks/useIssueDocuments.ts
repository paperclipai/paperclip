import { useQuery } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

/**
 * All of the issue's non-system documents, bodies included (the list endpoint
 * filters system keys server-side and returns full documents). Shared by the
 * properties pane's tab gating and the Plan/Artifacts tab bodies so they all
 * consume one cached fetch. Keyed under queryKeys.issues.documents so
 * document-scope invalidations refresh it alongside the single-doc queries.
 */
export function useIssueDocuments(issueId: string | null | undefined) {
  return useQuery<IssueDocument[]>({
    queryKey: [...queryKeys.issues.documents(issueId ?? ""), "list"],
    enabled: Boolean(issueId),
    queryFn: () => issuesApi.listDocuments(issueId!),
  });
}
