import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ISSUE_CHAT_BOOTSTRAP_MAX_IDS } from "@paperclipai/shared";
import { loadIssueChatBootstraps } from "@/lib/issue-chat-bootstrap";
import { hasFreshIssueChatFirstFrame } from "@/lib/issueChatBootstrapCache";
import { whenPageSettles } from "@/lib/when-page-settles";
import { useWarmTaskDetailCode } from "./useWarmTaskDetailCode";

export type RecentTaskOpenWarmupTask = { id: string; identifier: string | null };

let preloadedScopes = new WeakMap<QueryClient, Map<string, Set<string>>>();

export function resetRecentTaskChatPreloadForTests() {
  preloadedScopes = new WeakMap();
}

/**
 * Make opening a recent task from the sidebar nearly instant.
 *
 * Once Recents has painted, warm the task-detail code as task lists do. Then,
 * once the page is idle, read the chat's first frame for the most recent tasks
 * in one `chat-bootstrap` request and seed it into the task page's caches.
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
  const topTasksKey = JSON.stringify(tasks.slice(0, ISSUE_CHAT_BOOTSTRAP_MAX_IDS).map(task => [task.id, task.identifier]));
  // Read when the preload starts. A reorder must not cancel a request in flight.
  const latestTasks = useRef(tasks);
  latestTasks.current = tasks;
  useEffect(() => {
    if (!companyId || !hasTasks || typeof window.requestAnimationFrame !== "function") return;
    const scope = `${companyId}:${userId ?? "__local_board__"}`;
    let scopes = preloadedScopes.get(queryClient);
    if (!scopes) preloadedScopes.set(queryClient, scopes = new Map());
    let preloaded = scopes.get(scope);
    if (!preloaded) scopes.set(scope, preloaded = new Set());
    const remembered = preloaded;
    const controller = new AbortController();
    const cancel = whenPageSettles(queryClient, () => {
      // Skips tasks already cached or loading (a task list may have preloaded them).
      const top = latestTasks.current.slice(0, ISSUE_CHAT_BOOTSTRAP_MAX_IDS).filter(task => !remembered.has(task.id));
      if (!top.length) return;
      for (const task of top) remembered.add(task.id);
      void loadIssueChatBootstraps(queryClient, companyId, top, { signal: controller.signal }).then(() => {
        for (const task of top) {
          const refs = [task.id, task.identifier].filter((ref): ref is string => !!ref);
          if (!hasFreshIssueChatFirstFrame(queryClient, refs)) remembered.delete(task.id);
        }
      });
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [companyId, hasTasks, queryClient, userId, topTasksKey]);
}
