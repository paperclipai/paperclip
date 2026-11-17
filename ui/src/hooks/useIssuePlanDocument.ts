import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { readFromIssueChatBootstrap } from "@/lib/issue-chat-bootstrap";
import { queryKeys } from "@/lib/queryKeys";

const PLAN_DOCUMENT_STALE_TIME_MS = 30_000;

/**
 * The issue's `plan` document, or null when none exists (a 404 is the normal
 * "no plan yet" answer, not an error). Shared by the redesigned thread (its
 * "Plan updated" marker) and the properties pane's Plan tab, so both consume
 * one cached fetch. Keyed under queryKeys.issues.documents so document-scope
 * invalidations refresh it. A first read while the task's chat bootstrap is
 * loading uses the plan projection of its task instead of another request.
 */
export function useIssuePlanDocument(issueId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = [...queryKeys.issues.documents(issueId ?? ""), "plan"];
  return useQuery<IssueDocument | null>({
    queryKey,
    enabled: Boolean(issueId) && !issueId?.startsWith("chat:"),
    staleTime: PLAN_DOCUMENT_STALE_TIME_MS,
    queryFn: () => readFromIssueChatBootstrap(queryClient, queryKey, issueId!, (item) => item.issue.planDocument, async () => {
      try {
        return await issuesApi.getDocument(issueId!, "plan");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    }),
  });
}
