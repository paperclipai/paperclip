import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import {
  loadDismissedInboxItems,
  saveDismissedInboxItems,
  loadReadInboxItems,
  saveReadInboxItems,
  READ_ITEMS_KEY,
} from "../lib/inbox";

const retryFeedbackRunListeners = new Set<() => void>();
let retryFeedbackRunIdsStore = new Set<string>();

function cloneRetryFeedbackRunIds() {
  return new Set(retryFeedbackRunIdsStore);
}

function publishRetryFeedbackRunIds(next: Set<string>) {
  retryFeedbackRunIdsStore = next;
  for (const listener of retryFeedbackRunListeners) {
    listener();
  }
}

export function useDismissedInboxItems() {
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissedInboxItems);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "paperclip:inbox:dismissed") return;
      setDismissed(loadDismissedInboxItems());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedInboxItems(next);
      return next;
    });
  };

  return { dismissed, dismiss };
}

export function useReadInboxItems() {
  const [readItems, setReadItems] = useState<Set<string>>(loadReadInboxItems);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== READ_ITEMS_KEY) return;
      setReadItems(loadReadInboxItems());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const markRead = (id: string) => {
    setReadItems((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveReadInboxItems(next);
      return next;
    });
  };

  const markUnread = (id: string) => {
    setReadItems((prev) => {
      const next = new Set(prev);
      next.delete(id);
      saveReadInboxItems(next);
      return next;
    });
  };

  return { readItems, markRead, markUnread };
}

export function useRetryFeedbackRunIds() {
  const [retryFeedbackRunIds, setRetryFeedbackRunIds] = useState<Set<string>>(cloneRetryFeedbackRunIds);

  useEffect(() => {
    const handleChange = () => {
      setRetryFeedbackRunIds(cloneRetryFeedbackRunIds());
    };
    retryFeedbackRunListeners.add(handleChange);
    return () => {
      retryFeedbackRunListeners.delete(handleChange);
    };
  }, []);

  const pinRun = useCallback((runId: string) => {
    if (retryFeedbackRunIdsStore.has(runId)) return;
    const next = cloneRetryFeedbackRunIds();
    next.add(runId);
    publishRetryFeedbackRunIds(next);
  }, []);

  const clearRun = useCallback((runId: string) => {
    if (!retryFeedbackRunIdsStore.has(runId)) return;
    const next = cloneRetryFeedbackRunIds();
    next.delete(runId);
    publishRetryFeedbackRunIds(next);
  }, []);

  return { retryFeedbackRunIds, pinRun, clearRun };
}

export function useInboxBadge(companyId: string | null | undefined) {
  const { data: summary } = useQuery({
    queryKey: queryKeys.inboxSummary(companyId!),
    queryFn: () => companiesApi.inboxSummary(companyId!),
    enabled: !!companyId,
  });

  return useMemo(
    () => summary ?? {
      inbox: 0,
      approvals: 0,
      failedRuns: 0,
      joinRequests: 0,
      mineIssues: 0,
      alerts: 0,
      failedRunSummaries: [],
    },
    [summary],
  );
}
