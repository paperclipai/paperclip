import { useEffect, useRef } from "react";
import { useBlocker } from "@/lib/router";

export function useUnsavedNavigationGuard(when: boolean, message: string) {
  const blocker = useBlocker(when);
  const promptActiveRef = useRef(false);

  useEffect(() => {
    if (blocker.state !== "blocked") {
      promptActiveRef.current = false;
      return;
    }

    if (promptActiveRef.current) return;
    promptActiveRef.current = true;

    if (window.confirm(message)) {
      setTimeout(blocker.proceed, 0);
    } else {
      blocker.reset();
    }
  }, [blocker, message]);

  return blocker;
}
