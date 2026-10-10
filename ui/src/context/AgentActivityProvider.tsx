import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { useOptionalCompany } from "./CompanyContext";
import { useSharedPollingQuery, usePublishSharedQueryData } from "../hooks/useSharedPolling";
import {
  collectLiveIssueIds,
  trackLiveRunCoverage,
  isCompanyLiveRunCoverageComplete,
  INITIAL_LIVE_RUN_COVERAGE,
  LIVE_RUNS_PAGE_LIMIT,
} from "../lib/liveIssueIds";
import { queryKeys } from "../lib/queryKeys";

/**
 * Which issues currently have an agent working on them (PAP-640).
 *
 * Task *status* and agent *activity* are different things: a task can sit in
 * `in_progress` for hours between runs with nobody executing. This provider
 * owns the one company-wide live-run read (same query key, shared-polling
 * resource and event-sourced cache as the sidebar, so the two dedupe) and
 * exposes just the issue ids with a queued/running run — the same "live"
 * definition the Live pill and `liveIssueIds` use elsewhere.
 *
 * Consumers read it through {@link useIsAgentWorkingOnIssue}; the status glyph
 * uses it to animate the in-progress icon only while work is actually moving.
 *
 * The live-run endpoint pages at {@link LIVE_RUNS_PAGE_LIMIT}, so the set is
 * only a complete census of working issues while the page is not full. Above
 * that concurrency the provider says so via `coverageComplete`, and consumers
 * stop reading a missing issue as an idle one.
 */
interface AgentActivity {
  /** Issues with a queued/running run, as far as this window can see. */
  activeIssueIds: ReadonlySet<string>;
  /** False when the live-run window is truncated, so absence proves nothing. */
  coverageComplete: boolean;
}

const AgentActivityContext = createContext<AgentActivity | null>(null);

/** Outside a provider nothing is known to be running, and nothing is truncated. */
const NO_ACTIVITY: AgentActivity = { activeIssueIds: new Set<string>(), coverageComplete: true };

export function AgentActivityProvider({ children }: { children: ReactNode }) {
  const company = useOptionalCompany();
  const companyId = company?.selectedCompanyId ?? null;
  const liveRunsQueryKey = queryKeys.liveRuns(companyId ?? "__no-company__");
  const sharedLiveRuns = useSharedPollingQuery<LiveRunForIssue[]>({
    companyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!companyId,
    // Event-sourced via LiveUpdatesProvider, like every other live-runs reader.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    // Ask for the page size we test against, so a full page is unambiguous.
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!, { limit: LIVE_RUNS_PAGE_LIMIT }),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);

  // Run progress events rewrite the live-runs array constantly (byte counts,
  // status messages) while the *set of working issues* barely changes. Keep the
  // previous Set whenever its members are unchanged so a progress tick doesn't
  // re-render every status icon in the app.
  const activeIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);
  const stableIssueIds = useRef(activeIssueIds);
  if (!sameMembers(stableIssueIds.current, activeIssueIds)) stableIssueIds.current = activeIssueIds;
  const workingIssueIds = stableIssueIds.current;
  // Latched, not recomputed: run-lifecycle events remove finished runs from this
  // same array, so a truncated page drops under the cap on its own and would
  // otherwise start passing for a complete one. Kept per company, because this
  // provider outlives every switch: a busy company must not silence the next
  // one, and coming back must not trust the page that shrank while we were away.
  const coverage = useRef(INITIAL_LIVE_RUN_COVERAGE);
  coverage.current = trackLiveRunCoverage(coverage.current, companyId, liveRuns);
  const coverageComplete = isCompanyLiveRunCoverageComplete(coverage.current, companyId);

  const activity = useMemo<AgentActivity>(
    () => ({ activeIssueIds: workingIssueIds, coverageComplete }),
    [workingIssueIds, coverageComplete],
  );

  return <AgentActivityContext.Provider value={activity}>{children}</AgentActivityContext.Provider>;
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * True when an agent is actively working (queued or running run) on this issue.
 *
 * Returns false without an id and outside the provider, so provider-less
 * surfaces and unit tests degrade to the calm, non-animated rendering. When the
 * live-run window is truncated it returns true for every issue instead: the
 * honest answer there is "cannot tell", and the pre-PAP-640 always-animate
 * rendering is the safe side of that — it never tells you a busy task is idle.
 */
export function useIsAgentWorkingOnIssue(issueId: string | null | undefined): boolean {
  const { activeIssueIds, coverageComplete } = useContext(AgentActivityContext) ?? NO_ACTIVITY;
  return !!issueId && (!coverageComplete || activeIssueIds.has(issueId));
}

/** Test/story seam: provide a fixed working-issue set without any data fetching. */
export function AgentActivityTestProvider({
  activeIssueIds,
  coverageComplete = true,
  children,
}: {
  activeIssueIds: ReadonlySet<string>;
  /** Pass false to simulate a truncated live-run window. */
  coverageComplete?: boolean;
  children: ReactNode;
}) {
  const activity = useMemo<AgentActivity>(
    () => ({ activeIssueIds, coverageComplete }),
    [activeIssueIds, coverageComplete],
  );
  return <AgentActivityContext.Provider value={activity}>{children}</AgentActivityContext.Provider>;
}
