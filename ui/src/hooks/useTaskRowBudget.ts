import { useEffect, useRef, useState } from "react";

const INITIAL_ROWS = 100;
const ROW_BATCH = 150;
const rememberedBudgets = new Map<string, number>();

/** Bound React work across the whole tree. A view/filter change resets the
 * budget; paging and background changes retain every already revealed row. */
export function useTaskRowBudget(rowIds: readonly string[], viewKey: string) {
  const key = rowIds.join("\0");
  const [budget, setBudget] = useState(() => ({ viewKey, key, ids: rowIds, limit: rememberedBudgets.get(viewKey) ?? INITIAL_ROWS }));
  const sameView = budget.viewKey === viewKey;
  let limit = sameView ? budget.limit : rememberedBudgets.get(viewKey) ?? INITIAL_ROWS;
  if (sameView && budget.key !== key) {
    const revealed = new Set(budget.ids.slice(0, budget.limit));
    // Older pages can sort before existing rows. Keep the last revealed row
    // inside the new prefix rather than assuming that fetched pages append.
    rowIds.forEach((id, index) => { if (revealed.has(id)) limit = Math.max(limit, index + 1); });
  }
  const hasMore = rowIds.length > limit;
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = () => setBudget({ viewKey, key, ids: rowIds, limit: limit + ROW_BATCH });

  useEffect(() => {
    if (!sameView || budget.key !== key || budget.limit !== limit) setBudget({ viewKey, key, ids: rowIds, limit });
    // Remember only presentation counts, never records. Reopening the same view
    // has its previous height before the shell restores the reading position.
    rememberedBudgets.delete(viewKey);
    rememberedBudgets.set(viewKey, limit);
    if (rememberedBudgets.size > 50) rememberedBudgets.delete(rememberedBudgets.keys().next().value!);
  }, [viewKey, key, sameView, budget.key, budget.limit, limit, rowIds]);

  useEffect(() => {
    const element = sentinel.current;
    if (!hasMore || !element || typeof IntersectionObserver === "undefined") return;
    let root = element.parentElement;
    while (root && root !== document.body) {
      const style = window.getComputedStyle(root);
      if (["auto", "scroll", "overlay"].includes(style.overflowY) && root.scrollHeight > root.clientHeight) break;
      root = root.parentElement;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setBudget({ viewKey, key, ids: rowIds, limit: limit + ROW_BATCH });
    }, { root: root === document.body ? null : root });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, viewKey, key, limit, rowIds]);

  return { limit, hasMore, sentinel, loadMore };
}
