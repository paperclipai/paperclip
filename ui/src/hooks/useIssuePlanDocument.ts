import { useQuery } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The issue's `plan` document, or null when none exists. Shared by the
 * redesigned thread (its "Plan updated" marker) and the properties pane's
 * Plan tab, so both consume one cached fetch. Keyed under
 * queryKeys.issues.documents so document-scope invalidations refresh it.
 */
export function useIssuePlanDocument(issueId: string | null | undefined) {
  return useQuery<IssueDocument | null>({
    queryKey: [...queryKeys.issues.documents(issueId ?? ""), "plan"],
    enabled: Boolean(issueId) && !issueId?.startsWith("chat:"),
    queryFn: () => issuesApi.getDocument(issueId!, "plan", { optional: true }),
  });
}
