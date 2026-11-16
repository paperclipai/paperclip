import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ISSUE_CHAT_BOOTSTRAP_MAX_IDS } from "@paperclipai/shared";
import { loadIssueChatBootstraps } from "@/lib/issue-chat-bootstrap";
import { whenPageSettles } from "@/lib/when-page-settles";
import { useWarmTaskDetailCode } from "./useWarmTaskDetailCode";

export type RecentTaskOpenWarmupTask = { id: string; identifier: string | null };

/**
 * Make opening a recent task from the sidebar nearly instant.
 *
 * Once Recents has painted, warm the task-detail code as task lists do. Then,
 * once the page is idle, read the chat's first frame for the most recent tasks
 * in one `chat-bootstrap` request and seed it into the task page's caches.
 *
 * The sidebar stays mounted for the whole session, so it repeats this after
 * each navigation (`navigationKey`), as a task list does each time it is
 * shown. Like a list's preload it skips tasks cached and fresh, loading, or
 * preloaded in the last five minutes, so most navigations send nothing. A warm
 * that is never repeated goes cold: unread cache entries are dropped after
 * five minutes.
 */
export function useRecentTaskOpenWarmup({
  companyId,
  userId,
  tasks,
  navigationKey,
}: {
  companyId: string | null | undefined;
  userId: string | null | undefined;
  tasks: readonly RecentTaskOpenWarmupTask[];
  navigationKey?: string;
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
    const controller = new AbortController();
    const cancel = whenPageSettles(queryClient, () => {
      const top = latestTasks.current.slice(0, ISSUE_CHAT_BOOTSTRAP_MAX_IDS);
      void loadIssueChatBootstraps(queryClient, companyId, top, { signal: controller.signal, background: true });
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [companyId, hasTasks, queryClient, userId, topTasksKey, navigationKey]);
}
