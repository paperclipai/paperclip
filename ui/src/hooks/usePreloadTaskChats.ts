import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CHAT_BOOTSTRAP_PRELOAD_LIMIT, loadIssueChatBootstraps } from "@/lib/issue-chat-bootstrap";
import { whenPageSettles } from "@/lib/when-page-settles";

/**
 * The route refs of the first tasks in `items`, in order, up to the preload
 * limit. `taskOf` returns the task an item shows, or null for other items.
 * The walk stops at the limit, whatever the size of the list.
 */
export function topTaskRefs<T>(items: Iterable<T>, taskOf: (item: T) => { id: string; identifier: string | null } | null) {
  const refs: string[] = [];
  for (const item of items) {
    const task = taskOf(item);
    if (!task) continue;
    refs.push(task.identifier ?? task.id);
    if (refs.length >= CHAT_BOOTSTRAP_PRELOAD_LIMIT) break;
  }
  return refs;
}

/**
 * The route refs of the first rendered task rows of a list's flattened
 * display order, up to the preload limit. Rows past the render budget are
 * skipped; the walk stops at the limit.
 */
export function topRenderedNavEntryRefs(
  entries: readonly ({ type: "issue"; issue: { id: string; identifier: string | null }; budgetOrdinal: number } | { type: string })[],
  renderedRowLimit: number,
) {
  const refs: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "issue" || !("issue" in entry) || entry.budgetOrdinal > renderedRowLimit) continue;
    refs.push(entry.issue.identifier ?? entry.issue.id);
    if (refs.length >= CHAT_BOOTSTRAP_PRELOAD_LIMIT) break;
  }
  return refs;
}

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
      void loadIssueChatBootstraps(queryClient, companyId, refsKey.split(","), { signal: controller.signal, background: true });
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [companyId, queryClient, ready, refsKey]);
}
