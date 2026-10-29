import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
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

export function useRecentTasks({
  companyId,
  userId,
}: {
  companyId: string | null | undefined;
  userId: string | null | undefined;
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
  const entries = snapshot.storageKey === storageKey
    ? snapshot.entries
    : storageKey && companyId ? readRecentTasks(storageKey, companyId) : [];
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

  const queryIds = useMemo(() => entries.map((entry) => entry.id).sort(), [entries]);
  const membership = JSON.stringify(queryIds);
  const scope = JSON.stringify([storageKey, queryIds]);
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
    queryFn: ({ signal }) => issuesApi.summaries(companyId!, queryIds, { signal }),
    enabled: Boolean(companyId && queryIds.length),
    retry: false,
    staleTime: 30_000,
  });
  // Observe completion even when structural sharing preserves the data object.
  // The successful-update counter itself is only available on the cache state.
  const fetchingSummaries = summaryQuery.isFetching;
  const updateCount = queryClient.getQueryState(summaryKey)?.dataUpdateCount ?? 0;
  const summaries = summaryQuery.isSuccess ? summaryQuery.data : undefined;
  const confirmed = new Map((summaries ?? []).filter((issue) => issue.companyId === companyId)
    .map((issue) => [issue.id, issue]));
  const refreshedEntries = entries.map((entry) => {
    const issue = confirmed.get(entry.id);
    return issue ? mergeRecentTaskSnapshot(entry, issue) : entry;
  });
  const processed = useRef<{ scope: string; revision: number } | null>(null);

  useEffect(() => {
    if (!storageKey || !companyId || !summaries) return;
    if (processed.current?.scope === scope && processed.current.revision === updateCount) return;
    processed.current = { scope, revision: updateCount };
    const returnedIds = new Set(summaries.filter((issue) => issue.companyId === companyId).map((issue) => issue.id));
    updateRecentTaskSnapshots(storageKey, companyId, summaries);
    const omittedIds = new Set(queryIds.filter((id) => !returnedIds.has(id)));
    if (omittedIds.size && updateCount <= batchVisit.initialUpdateCount) {
      void summaryQuery.refetch({ cancelRefetch: false });
      return;
    }
    // Never prune IDs added after this particular batch was requested.
    pruneRecentTasks(storageKey, companyId, omittedIds);
    // A storage notification must not republish the same successful revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchVisit, companyId, fetchingSummaries, scope, updateCount, summaries, storageKey]);

  useEffect(() => {
    if (!storageKey || !companyId || !summaries) return;
    const authorizedIds = new Set(summaries.filter((issue) => issue.companyId === companyId).map((issue) => issue.id));
    const mergeCached = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const issue = value as Issue;
      if (!authorizedIds.has(issue.id) || issue.companyId !== companyId || issue.hiddenAt
        || typeof issue.title !== "string" || typeof issue.status !== "string"
        || !issue.updatedAt || !Object.hasOwn(issue, "projectId")) return;
      // At equal task versions, the summary's independently computed readiness
      // is newer than an already-cached full detail response.
      const summary = summaries.find((item) => item.id === issue.id);
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

  const [settledOrder, setSettledOrder] = useState(() => entries.map((entry) => entry.id));
  const activityRevision = JSON.stringify(entries.map((entry) => [entry.id, entry.recordedAt]));
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

  const entryById = new Map(refreshedEntries.map((entry) => [entry.id, entry]));
  const hasSameMembership = settledOrder.length === entries.length && settledOrder.every((id) => entryById.has(id));

  return {
    entries: hasSameMembership ? settledOrder.map((id) => entryById.get(id)!) : refreshedEntries,
    storageKey,
  };
}
