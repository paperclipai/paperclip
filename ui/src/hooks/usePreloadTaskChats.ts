import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CHAT_BOOTSTRAP_PRELOAD_LIMIT, loadIssueChatBootstraps } from "@/lib/issue-chat-bootstrap";

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * After a task list has painted, load what the chat of each of its top rows
 * needs before its first frame, so opening one of them renders from cache.
 * Runs at idle time, in requests of at most ten tasks, one at a time, and
 * skips tasks preloaded recently. A change of rows or company cancels it.
 */
export function usePreloadTaskChats(companyId: string | null | undefined, refs: readonly string[], ready: boolean) {
  const queryClient = useQueryClient();
  const refsKey = refs.slice(0, CHAT_BOOTSTRAP_PRELOAD_LIMIT).join(",");
  useEffect(() => {
    if (!ready || !companyId || !refsKey) return;
    const top = refsKey.split(",");
    const controller = new AbortController();
    const win = window as IdleWindow;
    const run = () => {
      if (document.visibilityState === "hidden") return;
      void loadIssueChatBootstraps(queryClient, companyId, top, { signal: controller.signal });
    };
    // Let the list finish painting and settle its own reads first.
    const idle = win.requestIdleCallback ? win.requestIdleCallback(run, { timeout: 1_500 }) : undefined;
    const timer = idle === undefined ? window.setTimeout(run, 300) : undefined;
    return () => {
      controller.abort();
      if (idle !== undefined) win.cancelIdleCallback?.(idle);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [companyId, queryClient, ready, refsKey]);
}
