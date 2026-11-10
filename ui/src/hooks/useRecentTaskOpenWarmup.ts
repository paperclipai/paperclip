import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ISSUE_CHAT_BOOTSTRAP_MAX_IDS } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { hasFreshIssueChatFirstFrame, seedIssueChatBootstrap } from "@/lib/issueChatBootstrapCache";
import { useWarmTaskDetailCode } from "./useWarmTaskDetailCode";

export type RecentTaskOpenWarmupTask = { id: string; identifier: string | null };

/** Accounts (company and user) whose Recents were preloaded during this page load. */
const preloadedScopes = new Set<string>();

export function resetRecentTaskChatPreloadForTests() {
  preloadedScopes.clear();
}

const IDLE_TIMEOUT_MS = 2_000;

/**
 * Run `start` once the page has painted, the tab is visible, no query is
 * fetching (the page's own reads have finished) and the browser is idle.
 * Returns a cancel function.
 */
function whenPageSettles(queryClient: QueryClient, start: () => void) {
  const cleanups = new Set<() => void>();
  const add = (cleanup: () => void) => cleanups.add(cleanup);
  let done = false;
  const cancel = () => {
    done = true;
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  };
  const step = () => {
    if (done) return;
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
    if (document.visibilityState !== "visible") {
      const onVisible = () => { if (document.visibilityState === "visible") step(); };
      document.addEventListener("visibilitychange", onVisible);
      add(() => document.removeEventListener("visibilitychange", onVisible));
      return;
    }
    if (queryClient.isFetching() > 0) {
      add(queryClient.getQueryCache().subscribe(() => {
        if (queryClient.isFetching() === 0) step();
      }));
      return;
    }
    const run = () => {
      if (done) return;
      // Something started while waiting for idle time: wait for it as well.
      if (document.visibilityState !== "visible" || queryClient.isFetching() > 0) {
        step();
        return;
      }
      done = true;
      cleanups.clear();
      start();
    };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
      add(() => window.cancelIdleCallback(handle));
    } else {
      const handle = window.setTimeout(run, 200);
      add(() => window.clearTimeout(handle));
    }
  };
  // Two frames: the page's primary content has painted.
  let second: number | undefined;
  const first = window.requestAnimationFrame(() => { second = window.requestAnimationFrame(step); });
  add(() => {
    window.cancelAnimationFrame(first);
    if (second !== undefined) window.cancelAnimationFrame(second);
  });
  return cancel;
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
      const ids = latestTasks.current
        .slice(0, ISSUE_CHAT_BOOTSTRAP_MAX_IDS)
        .filter((task) => !hasFreshIssueChatFirstFrame(queryClient, task.identifier ? [task.id, task.identifier] : [task.id]))
        .map((task) => task.id);
      if (!ids.length) return;
      const requestedAt = Date.now();
      // A synchronous throw (bad input) is also only a missed preload.
      Promise.resolve().then(() => issuesApi.chatBootstrap(companyId, ids, { signal: controller.signal })).then((response) => {
        if (controller.signal.aborted) return;
        for (const item of response.items) seedIssueChatBootstrap(queryClient, item, { companyId, requestedAt });
      }).catch(() => {
        // Best effort: a task opened later reads its own first frame.
      });
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [companyId, hasTasks, queryClient, userId]);
}
