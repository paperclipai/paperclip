import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ISSUE_CHAT_BOOTSTRAP_MAX_IDS } from "@paperclipai/shared";
import { loadIssueChatBootstraps } from "@/lib/issue-chat-bootstrap";
import { whenPageSettles } from "@/lib/when-page-settles";
import { useWarmTaskDetailCode } from "./useWarmTaskDetailCode";

export type RecentTaskOpenWarmupTask = { id: string; identifier: string | null };

/** Accounts (company and user) whose Recents were preloaded during this page load. */
const preloadedScopes = new Set<string>();

export function resetRecentTaskChatPreloadForTests() {
  preloadedScopes.clear();
}

/**
 * Make opening a recent task from the sidebar nearly instant.
 *
 * Once Recents has painted, warm the task-detail code as task lists do. Then,
 * once the page is idle, read the chat's first frame for the most recent tasks
 * in one `chat-bootstrap` request and seed it into the task page's caches.
 * At most one request per account per page load; none for an empty list, a
 * hidden tab or tasks whose first frame is already cached and fresh. Live
 * updates keep seeded entries fresh afterwards, one task at a time.
 */
export function useRecentTaskOpenWarmup({
  companyId,
  userId,
  tasks,
}: {
  companyId: string | null | undefined;
  userId: string | null | undefined;
  tasks: readonly RecentTaskOpenWarmupTask[];
}) {
  const queryClient = useQueryClient();
  const hasTasks = tasks.length > 0;
  useWarmTaskDetailCode(hasTasks);
  // Read when the preload starts. A reorder must not cancel a request in flight.
  const latestTasks = useRef(tasks);
  latestTasks.current = tasks;
  useEffect(() => {
    if (!companyId || !hasTasks || typeof window.requestAnimationFrame !== "function") return;
    const scope = `${companyId}:${userId ?? "__local_board__"}`;
    if (preloadedScopes.has(scope)) return;
    const controller = new AbortController();
    const cancel = whenPageSettles(queryClient, () => {
      if (preloadedScopes.has(scope)) return;
      preloadedScopes.add(scope);
      // Skips tasks already cached or loading (a task list may have preloaded them).
      const top = latestTasks.current.slice(0, ISSUE_CHAT_BOOTSTRAP_MAX_IDS);
      void loadIssueChatBootstraps(queryClient, companyId, top, { signal: controller.signal });
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [companyId, hasTasks, queryClient, userId]);
}
