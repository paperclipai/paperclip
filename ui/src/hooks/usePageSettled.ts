import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { whenPageSettles } from "@/lib/when-page-settles";

/** The longest a settle wait may last on a page that keeps reading. */
export const PAGE_SETTLED_MAX_WAIT_MS = 5_000;

/**
 * False on mount, true once the page has painted and its reads have finished
 * (see `whenPageSettles`), or after `maxWaitMs` on a page that never settles.
 * Use it to start reads that never affect the first frame, so they do not
 * compete with the reads that do.
 */
export function usePageSettled(maxWaitMs = PAGE_SETTLED_MAX_WAIT_MS) {
  const queryClient = useQueryClient();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (settled) return;
    const done = () => setSettled(true);
    const cancel = whenPageSettles(queryClient, done);
    const timer = window.setTimeout(done, maxWaitMs);
    return () => {
      cancel();
      window.clearTimeout(timer);
    };
  }, [queryClient, settled, maxWaitMs]);
  return settled;
}
