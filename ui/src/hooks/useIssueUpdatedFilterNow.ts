import { useEffect, useMemo, useState } from "react";
import type { Issue } from "@paperclipai/shared";
import { nextIssueUpdatedFilterExpiryMs, type IssueUpdatedWithin } from "../lib/issue-filters";

const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Provides a stable `Date` reference for relative Updated time filters (`24h`,
 * `3d`, `7d`, `30d`) and schedules a single deadline timer for the earliest
 * visible task that will age out of the active window. Returns `undefined` when
 * no relative window is active so callers pay zero timer or re-render cost.
 */
export function useIssueUpdatedFilterNow(
  issues: ReadonlyArray<Pick<Issue, "updatedAt" | "lastActivityAt" | "lastExternalCommentAt">>,
  updatedWithin: IssueUpdatedWithin | null | undefined,
): Date | undefined {
  const isRelative = Boolean(updatedWithin && updatedWithin !== "custom");
  const [tick, setTick] = useState(0);

  const nowMs = useMemo(
    () => (isRelative ? Date.now() : null),
    [isRelative, issues, updatedWithin, tick],
  );

  const nextExpiryMs = useMemo(
    () => (nowMs === null ? null : nextIssueUpdatedFilterExpiryMs(issues, updatedWithin, nowMs)),
    [issues, updatedWithin, nowMs],
  );

  useEffect(() => {
    if (nextExpiryMs === null) return;
    const delayMs = Math.max(0, Math.min(nextExpiryMs - Date.now(), MAX_TIMEOUT_MS));
    const timer = setTimeout(() => {
      setTick((current) => current + 1);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [nextExpiryMs, nowMs]);

  return useMemo(() => (nowMs === null ? undefined : new Date(nowMs)), [nowMs]);
}
