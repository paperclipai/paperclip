import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ISSUE_SUMMARIES_MAX_IDS, type Issue, type IssueSummary } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import {
  RECENT_TASKS_UPDATED_EVENT,
  getRecentTasksStorageKey,
  mergeRecentTaskSnapshot,
  migrateRecentTasks,
  pruneRecentTasks,
  readRecentTasks,
  updateRecentTaskSnapshots,
  type RecentTaskEntry,
} from "@/lib/recent-tasks";

type RecentTasksUpdatedDetail = {
  storageKey: string;
  entries: RecentTaskEntry[];
};

const RECENT_TASK_ORDER_DEBOUNCE_MS = 1_000;
const NO_PINNED_TASK_IDS: readonly string[] = [];
const NO_PINNED_TASKS: readonly IssueSummary[] = [];
/** Summary chunks in flight at once for a history longer than one request. */
export const RECENT_TASK_SUMMARY_CONCURRENCY = 3;

export function useRecentTasks({
  companyId,
  userId,
  pinnedTaskIds = NO_PINNED_TASK_IDS,
}: {
  companyId: string | null | undefined;
  userId: string | null | undefined;
  pinnedTaskIds?: readonly string[];
}) {
  const storageKey = useMemo(
    () => companyId ? getRecentTasksStorageKey(companyId, userId) : null,
    [companyId, userId],
  );
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState(() => ({
    storageKey,
    entries: storageKey && companyId ? readRecentTasks(storageKey, companyId) : [],
  }));
  // A scope change must not request the previous account's IDs for one render.
  const entries = useMemo(() => snapshot.storageKey === storageKey
    ? snapshot.entries
    : storageKey && companyId ? readRecentTasks(storageKey, companyId) : [], [snapshot, storageKey, companyId]);
  const setEntries = (next: RecentTaskEntry[]) => setSnapshot({ storageKey, entries: next });

  useEffect(() => {
    if (storageKey && companyId) migrateRecentTasks(storageKey, companyId);
    setEntries(storageKey && companyId ? readRecentTasks(storageKey, companyId) : []);
  }, [companyId, storageKey]);

  useEffect(() => {
    if (!storageKey || !companyId) return;

    const sync = () => setEntries(readRecentTasks(storageKey, companyId));
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) sync();
    };
    const onRecentTasksUpdated = (event: Event) => {
      const detail = (event as CustomEvent<RecentTasksUpdatedDetail>).detail;
      if (detail?.storageKey === storageKey) setEntries(detail.entries);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(RECENT_TASKS_UPDATED_EVENT, onRecentTasksUpdated);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(RECENT_TASKS_UPDATED_EVENT, onRecentTasksUpdated);
    };
  }, [companyId, storageKey]);

  const recentIds = useMemo(() => entries.map((entry) => entry.id).sort(), [entries]);
  const queryIds = useMemo(() => pinnedTaskIds.length ? [...new Set([...recentIds, ...pinnedTaskIds])].sort() : recentIds, [recentIds, pinnedTaskIds]);
  const scope = JSON.stringify([storageKey, recentIds, queryIds]);
  const summaryKey = queryKeys.issues.summaryBatch(companyId ?? "__none__", userId, queryIds);
  // A cached omission predates IDs that the user has just added back. Only a
  // response completed during this visit to the batch may remove those IDs.
  const batchVisit = useMemo(() => ({
    initialUpdateCount: queryClient.getQueryState(summaryKey)?.dataUpdateCount ?? 0,
    // The serialized scope includes the account, company, and sorted ID set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [queryClient, scope]);
  const summaryQuery = useQuery({
    queryKey: summaryKey,
    queryFn: async ({ signal }) => {
      // One request covers a typical list. Longer lists fetch their chunks a
      // few at a time rather than one after another or all at once.
      const chunks: string[][] = [];
      for (let offset = 0; offset < queryIds.length; offset += ISSUE_SUMMARIES_MAX_IDS) {
        chunks.push(queryIds.slice(offset, offset + ISSUE_SUMMARIES_MAX_IDS));
      }
      const results: IssueSummary[][] = new Array(chunks.length);
      let next = 0;
      const worker = async () => {
        while (next < chunks.length) {
          const index = next++;
          results[index] = await issuesApi.summaries(companyId!, chunks[index]!, { signal, navigation: true });
        }
      };
      await Promise.all(Array.from({ length: Math.min(RECENT_TASK_SUMMARY_CONCURRENCY, chunks.length) }, worker));
      return results.flat();
    },
    enabled: Boolean(companyId && queryIds.length),
    staleTime: 30_000,
    // Membership changes can keep already verified personal rows visible while
    // the new candidates load. Never carry facts across account/company scopes.
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === companyId
      && previousQuery?.queryKey[3] === (userId ?? "__local_board__") ? previous : undefined,
  });
  // Observe completion even when structural sharing preserves the data object.
  // The successful-update counter itself is only available on the cache state.
  const fetchingSummaries = summaryQuery.isFetching;
  const updateCount = queryClient.getQueryState(summaryKey)?.dataUpdateCount ?? 0;
  const summaries = summaryQuery.isSuccess ? summaryQuery.data : undefined;
  const [lastConfirmed, setLastConfirmed] = useState<{
    storageKey: string | null;
    summaries: IssueSummary[];
  } | null>(null);
  useEffect(() => {
    if (summaries && !summaryQuery.isPlaceholderData) setLastConfirmed({ storageKey, summaries });
  }, [summaries, summaryQuery.isPlaceholderData, storageKey]);
  // Placeholder data disappears when a new batch fails. Keep the last successful
  // authenticated batch for this scope, without admitting any new candidates.
  const confirmedRows = summaryQuery.data ?? (lastConfirmed?.storageKey === storageKey ? lastConfirmed.summaries : undefined);
  const confirmed = useMemo(() => new Map((confirmedRows ?? []).filter((issue) => issue.companyId === companyId)
    .map((issue) => [issue.id, issue])), [confirmedRows, companyId]);
  const error = summaryQuery.error;
  const denied = error instanceof ApiError && (error.status === 401 || error.status === 403);
  const pinnedTasks = useMemo(() => denied || !pinnedTaskIds.length ? NO_PINNED_TASKS : pinnedTaskIds.flatMap((id) => {
    const issue = confirmed.get(id);
    return issue ? [issue] : [];
  }), [confirmed, denied, pinnedTaskIds]);
  // A visit is only a candidate. Neither imported provenance nor a persisted
  // browser snapshot proves personal participation for the current account.
  const refreshedEntries = useMemo(() => entries.flatMap((entry) => {
    const issue = confirmed.get(entry.id);
    if (issue?.isParticipantForMe !== true || issue.isArchivedForMe) return [];
    return [{ ...mergeRecentTaskSnapshot(entry, issue), isUnreadForMe: issue.isUnreadForMe }];
  }), [entries, confirmed]);
  const processed = useRef<{ visit: typeof batchVisit; revision: number } | null>(null);

  useEffect(() => {
    if (!storageKey || !companyId || !summaries || summaryQuery.isPlaceholderData) return;
    if (processed.current?.visit === batchVisit && processed.current.revision === updateCount) return;
    processed.current = { visit: batchVisit, revision: updateCount };
    // Older cached summaries without the new projection cannot prove either
    // eligibility or ineligibility. Keep those candidates until a current read.
    const returnedIds = new Set(summaries.filter((issue) => issue.companyId === companyId && issue.isParticipantForMe !== false && !issue.isArchivedForMe).map((issue) => issue.id));
    updateRecentTaskSnapshots(storageKey, companyId, summaries);
    const omittedIds = new Set(recentIds.filter((id) => !returnedIds.has(id)));
    if (omittedIds.size && updateCount <= batchVisit.initialUpdateCount) {
      void summaryQuery.refetch({ cancelRefetch: false });
      return;
    }
    // Never prune IDs added after this particular batch was requested.
    pruneRecentTasks(storageKey, companyId, omittedIds);
    // A storage notification must not republish the same successful revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchVisit, companyId, fetchingSummaries, scope, updateCount, summaries, storageKey, summaryQuery.isPlaceholderData]);

  useEffect(() => {
    if (!storageKey || !companyId || !summaries) return;
    const summaryById = new Map(summaries.filter((issue) => issue.companyId === companyId).map((issue) => [issue.id, issue]));
    const authorizedIds = new Set([...summaryById.values()].filter(issue => issue.isParticipantForMe === true).map(issue => issue.id));
    const mergeCached = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const issue = value as Issue;
      if (!authorizedIds.has(issue.id) || issue.companyId !== companyId || issue.hiddenAt
        || typeof issue.title !== "string" || typeof issue.status !== "string"
        || !issue.updatedAt || !Object.hasOwn(issue, "projectId")) return;
      // At equal task versions, the summary's independently computed readiness
      // is newer than an already-cached full detail response.
      const summary = summaryById.get(issue.id);
      if (!summary || new Date(issue.updatedAt).getTime() <= new Date(summary.updatedAt).getTime()) return;
      updateRecentTaskSnapshots(storageKey, companyId, [issue]);
    };
    for (const id of authorizedIds) mergeCached(queryClient.getQueryData(queryKeys.issues.detail(id)));
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      const key = event.query.queryKey;
      if (key.length === 3 && key[0] === "issues" && key[1] === "detail"
        && event.query.state.status === "success") mergeCached(event.query.state.data);
    });
  }, [companyId, queryClient, summaries, storageKey]);

  const [settledOrder, setSettledOrder] = useState(() => refreshedEntries.map((entry) => entry.id));
  const membership = JSON.stringify(refreshedEntries.map((entry) => entry.id).sort());
  const activityRevision = JSON.stringify(refreshedEntries.map((entry) => [entry.id, entry.recordedAt]));
  useEffect(() => {
    const latestOrder = (JSON.parse(activityRevision) as Array<[string, number]>).map(([id]) => id);
    // Additions and removals are immediate. Only activity-driven moves wait for quiet.
    if (JSON.stringify([...settledOrder].sort((a, b) => a.localeCompare(b))) !== membership) {
      setSettledOrder(latestOrder);
      return;
    }
    if (latestOrder.every((id, index) => id === settledOrder[index])) return;
    const timeout = window.setTimeout(() => setSettledOrder(latestOrder), RECENT_TASK_ORDER_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [activityRevision, membership, settledOrder, storageKey]);

  const orderedEntries = useMemo(() => {
    const entryById = new Map(refreshedEntries.map((entry) => [entry.id, entry]));
    const hasSameMembership = settledOrder.length === refreshedEntries.length && settledOrder.every((id) => entryById.has(id));
    return hasSameMembership ? settledOrder.map((id) => entryById.get(id)!) : refreshedEntries;
  }, [refreshedEntries, settledOrder]);

  return {
    entries: orderedEntries,
    pinnedTasks,
    storageKey,
  };
}
