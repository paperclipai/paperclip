import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";

export type InboxIssueCacheSnapshot = Array<readonly [QueryKey, Issue[] | undefined]>;

function inboxIssueQueryPrefixes(companyId: string) {
  return [
    queryKeys.issues.listMineByMe(companyId),
    queryKeys.issues.listTouchedByMe(companyId),
    queryKeys.issues.listUnreadTouchedByMe(companyId),
  ] as const;
}

export async function cancelInboxIssueQueries(queryClient: QueryClient, companyId: string) {
  await Promise.all(
    inboxIssueQueryPrefixes(companyId).map((queryKey) =>
      queryClient.cancelQueries({ queryKey }),
    ),
  );
}

export function snapshotInboxIssueCaches(
  queryClient: QueryClient,
  companyId: string,
): InboxIssueCacheSnapshot {
  return inboxIssueQueryPrefixes(companyId).flatMap((queryKey) =>
    queryClient.getQueriesData<Issue[]>({ queryKey }),
  );
}

export function removeIssueFromInboxCaches(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
) {
  for (const queryKey of inboxIssueQueryPrefixes(companyId)) {
    queryClient.setQueriesData<Issue[]>(
      { queryKey },
      (cached) => cached?.filter((issue) => issue.id !== issueId),
    );
  }
}

export function restoreInboxIssueCaches(
  queryClient: QueryClient,
  snapshot: InboxIssueCacheSnapshot,
) {
  for (const [queryKey, data] of snapshot) {
    queryClient.setQueryData(queryKey, data);
  }
}

export function invalidateInboxIssueQueries(queryClient: QueryClient, companyId: string) {
  for (const queryKey of inboxIssueQueryPrefixes(companyId)) {
    queryClient.invalidateQueries({ queryKey });
  }
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
}
