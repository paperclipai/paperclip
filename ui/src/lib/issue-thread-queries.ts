import type { QueryClient } from "@tanstack/react-query";
import { activityApi } from "@/api/activity";
import { queryKeys } from "./queryKeys";

/** These requests do not depend on the enriched issue detail response. Start
 * them on navigation, using the same route ref the thread will observe. */
export function prefetchIssueThread(queryClient: QueryClient, issueRef: string) {
  return Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.issues.activity(issueRef),
      queryFn: () => activityApi.forIssue(issueRef),
      staleTime: 30_000,
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.issues.runs(issueRef),
      queryFn: () => activityApi.runsForIssue(issueRef),
      staleTime: 30_000,
    }),
  ]);
}
