import { useEffect, useRef, useState } from "react";

const INITIAL_ROWS = 100;
const ROW_BATCH = 150;

/** Bound React work across the entire tree, retaining revealed rows on append
 * and background enrichment. The sentinel uses the page's vertical scroller,
 * rather than the table's horizontal overflow container. */
export function useTaskRowBudget(rowIds: readonly string[]) {
  const key = rowIds.join("\0");
  const [budget, setBudget] = useState({ key, limit: INITIAL_ROWS });
  const sameOrAppend = key === budget.key || key.startsWith(`${budget.key}\0`);
  const limit = sameOrAppend ? budget.limit : INITIAL_ROWS;
  const hasMore = rowIds.length > limit;
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = () => setBudget({ key, limit: limit + ROW_BATCH });

  useEffect(() => {
    if (budget.key !== key) setBudget({ key, limit });
  }, [key, budget.key, limit]);

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
      if (entries.some(entry => entry.isIntersecting)) setBudget({ key, limit: limit + ROW_BATCH });
    }, { root: root === document.body ? null : root });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, key, limit]);

  return { limit, hasMore, sentinel, loadMore };
}
