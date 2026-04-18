import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { INBOX_MINE_ISSUE_STATUS_FILTER } from "@paperclipai/shared";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { approvalsApi } from "../api/approvals";
import { dashboardApi } from "../api/dashboard";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
  computeInboxBadgeData,
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
    return () => retryFeedbackRunListeners.delete(handleChange);
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
  const { dismissed } = useDismissedInboxItems();
  const { readItems } = useReadInboxItems();
  const { retryFeedbackRunIds } = useRetryFeedbackRunIds();

  const { data: approvals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(companyId!),
    queryFn: () => approvalsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: joinRequests = [] } = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(companyId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!companyId,
    retry: false,
  });

  const { data: dashboard } = useQuery({
    queryKey: queryKeys.dashboard(companyId!),
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: !!companyId,
  });

  const { data: heartbeatRuns = [] } = useQuery({
    queryKey: queryKeys.heartbeats(companyId!),
    queryFn: () => heartbeatsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: touchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.listTouchedByMe(companyId!),
    queryFn: () =>
      issuesApi.list(companyId!, {
        touchedByUserId: "me",
        status: INBOX_MINE_ISSUE_STATUS_FILTER,
      }),
    enabled: !!companyId,
  });

  return useMemo(
    () =>
      computeInboxBadgeData({
        approvals,
        joinRequests,
        dashboard,
        heartbeatRuns,
        mineIssues: touchedIssues,
        dismissed,
        readItems,
        retryFeedbackRunIds,
      }),
    [approvals, joinRequests, dashboard, heartbeatRuns, touchedIssues, dismissed, readItems, retryFeedbackRunIds],
  );
}
