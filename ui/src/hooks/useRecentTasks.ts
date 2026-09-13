import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import {
  RECENT_TASKS_UPDATED_EVENT,
  getRecentTasksStorageKey,
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
  const [entries, setEntries] = useState<RecentTaskEntry[]>(() => (
    storageKey && companyId ? readRecentTasks(storageKey, companyId) : []
  ));

  useEffect(() => {
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

  // Keep query observers in a fixed order when activity changes the display order.
  const queryEntries = [...entries].sort((left, right) => left.id.localeCompare(right.id));
  const detailQueries = useQueries({
    queries: queryEntries.map((entry) => ({
      queryKey: queryKeys.issues.detail(entry.id),
      queryFn: () => issuesApi.get(entry.id),
      retry: false,
      staleTime: 30_000,
    })),
  });

  const issueById = new Map(detailQueries.flatMap((query) => query.data ? [[query.data.id, query.data] as const] : []));
  const refreshedEntries = entries.map((entry) => {
    const issue = issueById.get(entry.id);
    if (!issue || issue.companyId !== companyId || issue.hiddenAt) return entry;
    return {
      ...entry,
      title: issue.title,
      identifier: issue.identifier,
      status: issue.status,
    };
  });
  const queryRevision = detailQueries
    .map((query) => `${query.dataUpdatedAt}:${query.errorUpdatedAt}:${query.status}`)
    .join("|");

  useEffect(() => {
    if (!storageKey || !companyId || detailQueries.length === 0) return;

    const resolvedIssues: Issue[] = [];
    const removeIds = new Set<string>();
    detailQueries.forEach((query, index) => {
      const entry = queryEntries[index];
      if (!entry) return;
      if (query.data) {
        if (query.data.companyId !== companyId || query.data.hiddenAt) {
          removeIds.add(entry.id);
        } else {
          resolvedIssues.push(query.data);
        }
      } else if (query.error instanceof ApiError && [403, 404].includes(query.error.status)) {
        removeIds.add(entry.id);
      }
    });

    updateRecentTaskSnapshots(storageKey, companyId, resolvedIssues);
    pruneRecentTasks(storageKey, companyId, removeIds);
    // queryRevision is the stable notification boundary for the useQueries result array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, entries, queryRevision, storageKey]);

  const [settledOrder, setSettledOrder] = useState(() => entries.map((entry) => entry.id));
  const membership = JSON.stringify(queryEntries.map((entry) => entry.id));
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
