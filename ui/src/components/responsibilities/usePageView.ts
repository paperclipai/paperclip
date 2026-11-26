import { useCallback, useState } from "react";
import { viewFromSearch, type ViewOption } from "@/lib/responsibility-views";
import { useLocation } from "@/lib/router";

export interface PageView<T extends string> {
  view: T;
  /** True while a view opened for one action is showing. */
  visiting: boolean;
  /** Show another view for one action, such as reviewing proposals. */
  visit: (view: T) => void;
  /** Return from a visited view. */
  leave: () => void;
}

/**
 * The view a page shows. The page has one view of its own (`fallback`) and no
 * switch between views: the earlier explorations stay reachable only by
 * naming one in the address (`?view=board`), which lasts for that address and
 * is not remembered. `visit` opens another view for one action; `leave`
 * returns from it.
 */
export function usePageView<T extends string>(options: readonly ViewOption<T>[], fallback: T): PageView<T> {
  const { search } = useLocation();
  const requested = viewFromSearch(search, options);
  const [visited, setVisited] = useState<T | null>(null);
  const leave = useCallback(() => setVisited(null), []);
  return { view: visited ?? requested ?? fallback, visiting: visited !== null, visit: setVisited, leave };
}
