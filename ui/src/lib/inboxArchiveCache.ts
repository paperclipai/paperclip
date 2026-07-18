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

function resolveRestoreIndex(currentData: Issue[], previousData: Issue[], previousIndex: number) {
  for (let index = previousIndex - 1; index >= 0; index -= 1) {
    const beforeIndex = currentData.findIndex((issue) => issue.id === previousData[index]?.id);
    if (beforeIndex >= 0) return beforeIndex + 1;
  }

  for (let index = previousIndex + 1; index < previousData.length; index += 1) {
    const afterIndex = currentData.findIndex((issue) => issue.id === previousData[index]?.id);
    if (afterIndex >= 0) return afterIndex;
  }

  return Math.min(previousIndex, currentData.length);
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

export function restoreIssueToInboxCaches(
  queryClient: QueryClient,
  snapshot: InboxIssueCacheSnapshot,
  issueId: string,
) {
  for (const [queryKey, previousData] of snapshot) {
    if (!previousData) continue;

    const previousIndex = previousData.findIndex((issue) => issue.id === issueId);
    if (previousIndex < 0) continue;

    const issueToRestore = previousData[previousIndex];
    queryClient.setQueryData<Issue[]>(queryKey, (currentData) => {
      if (currentData?.some((issue) => issue.id === issueId)) return currentData;

      const nextData = [...(currentData ?? [])];
      nextData.splice(resolveRestoreIndex(nextData, previousData, previousIndex), 0, issueToRestore);
      return nextData;
    });
  }
}

export function invalidateInboxIssueQueries(queryClient: QueryClient, companyId: string) {
  for (const queryKey of inboxIssueQueryPrefixes(companyId)) {
    queryClient.invalidateQueries({ queryKey });
  }
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
}
