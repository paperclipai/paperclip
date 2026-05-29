import { useEffect, useState } from "react";

export const ISSUE_RUN_POLL_MS = 5000;
export const ISSUE_RUN_BACKGROUND_POLL_MS = 15_000;

export function usePageVisible() {
  const [isVisible, setIsVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  useEffect(() => {
    const onVisibilityChange = () => {
      setIsVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return isVisible;
}

export function useWindowFocused() {
  const [isFocused, setIsFocused] = useState(() =>
    typeof document === "undefined" ? true : document.hasFocus(),
  );

  useEffect(() => {
    const onFocus = () => setIsFocused(true);
    const onBlur = () => setIsFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return isFocused;
}

type IssueRunPollInput = {
  wsHealthy: boolean;
  isPageVisible: boolean;
  hasLiveRuns: boolean;
  isWindowFocused?: boolean;
};

export function resolveIssueRunPollInterval({
  wsHealthy,
  isPageVisible,
  hasLiveRuns,
  isWindowFocused = true,
}: IssueRunPollInput): number | false {
  if (wsHealthy) return false;
  if (!isPageVisible) return false;
  if (hasLiveRuns) return isWindowFocused ? ISSUE_RUN_POLL_MS : ISSUE_RUN_BACKGROUND_POLL_MS;
  return false;
}
