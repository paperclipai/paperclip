import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CHAT_BOOTSTRAP_PRELOAD_LIMIT, loadIssueChatBootstraps } from "@/lib/issue-chat-bootstrap";
import { whenPageSettles } from "@/lib/when-page-settles";

/**
 * After a task list has painted and its own reads have settled, load what the
 * chat of each of its top rows needs before its first frame, so opening one
 * of them renders from cache. Tasks already cached, loading or preloaded
 * recently are skipped, so a reorder or a revisit sends nothing new. A change
 * of rows or company, or unmount, stops requests not yet sent.
 */
export function usePreloadTaskChats(companyId: string | null | undefined, refs: readonly string[], ready: boolean) {
  const queryClient = useQueryClient();
  const refsKey = refs.slice(0, CHAT_BOOTSTRAP_PRELOAD_LIMIT).join(",");
  useEffect(() => {
    if (!ready || !companyId || !refsKey || typeof window.requestAnimationFrame !== "function") return;
    const controller = new AbortController();
    const cancel = whenPageSettles(queryClient, () => {
      void loadIssueChatBootstraps(queryClient, companyId, refsKey.split(","), { signal: controller.signal });
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [companyId, queryClient, ready, refsKey]);
}
