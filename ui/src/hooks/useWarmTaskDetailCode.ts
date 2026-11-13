import { useEffect } from "react";
import { TASK_COLLECTION_PAINTED_EVENT } from "@/lib/issue-detail-preload-events";

export function useWarmTaskDetailCode(ready: boolean) {
  useEffect(() => {
    if (!ready || typeof window.requestAnimationFrame !== "function") return;
    let second: number | undefined;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => window.dispatchEvent(new Event(TASK_COLLECTION_PAINTED_EVENT)));
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second !== undefined) window.cancelAnimationFrame(second);
    };
  }, [ready]);
}
