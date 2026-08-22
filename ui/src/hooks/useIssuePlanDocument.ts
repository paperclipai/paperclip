import { useQuery } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The issue's `plan` document, or null when none exists (a 404 is the normal
 * "no plan yet" answer, not an error). Shared by the redesigned thread (its
 * "Plan updated" marker) and the properties pane's Plan tab, so both consume
 * one cached fetch. Keyed under queryKeys.issues.documents so document-scope
 * invalidations refresh it.
 */
export function useIssuePlanDocument(issueId: string | null | undefined) {
  return useQuery<IssueDocument | null>({
    queryKey: [...queryKeys.issues.documents(issueId ?? ""), "plan"],
    enabled: Boolean(issueId),
    queryFn: async () => {
      try {
        return await issuesApi.getDocument(issueId!, "plan");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
}
