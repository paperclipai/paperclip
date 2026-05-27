import { useEffect, useState } from "react";

export const ISSUE_RUN_POLL_MS = 3000;
export const ISSUE_RUN_BACKGROUND_POLL_MS = 10_000;

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

type IssueRunPollInput = {
  wsHealthy: boolean;
  isPageVisible: boolean;
  hasLiveRuns: boolean;
};

export function resolveIssueRunPollInterval({
  wsHealthy,
  isPageVisible,
  hasLiveRuns,
}: IssueRunPollInput): number | false {
  if (wsHealthy) return false;
  if (!isPageVisible) return false;
  if (hasLiveRuns) return ISSUE_RUN_POLL_MS;
  return ISSUE_RUN_POLL_MS;
}
