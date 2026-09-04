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

  const detailQueries = useQueries({
    queries: entries.map((entry) => ({
      queryKey: queryKeys.issues.detail(entry.id),
      queryFn: () => issuesApi.get(entry.id),
      retry: false,
      staleTime: 30_000,
    })),
  });

  const refreshedEntries = entries.map((entry, index) => {
    const issue = detailQueries[index]?.data;
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
      const entry = entries[index];
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

  return {
    entries: refreshedEntries,
    storageKey,
  };
}
