import type { QueryClient } from "@tanstack/react-query";
import type { ActivityEvent, Issue, IssueComment, IssueRecentComments } from "@paperclipai/shared";
import { activityApi, type RunForIssue } from "@/api/activity";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { prefetchIssueIdBatches } from "@/hooks/useIssueIdBatches";
import { queryKeys } from "@/lib/queryKeys";

// The compact task chat reveals its first frame only after these reads settle
// (see `initialHistoryPending` in IssueDetail). The page and navigation prefetch
// both build them here, so a prefetch fills exactly the keys the page reads.

export interface RecentIssueRunWindow {
  runs: RunForIssue[];
  hasEarlierRuns: boolean;
}

export function recentIssueActivityQueryKey(issueRef: string) {
  return [...queryKeys.issues.activity(issueRef), "recent"] as const;
}

export function recentIssueRunWindowQueryKey(issueRef: string) {
  return [...queryKeys.issues.runs(issueRef), "recent-window"] as const;
}

/** Base key of the batched input facts for the comments in the chat window. */
export function issueCommentInputFactsQueryKey(issueRef: string) {
  return [...queryKeys.issues.activity(issueRef), "comment-inputs"] as const;
}

/** The saved (not optimistic) comment ids whose input facts the chat reads, sorted. */
export function issueInputCommentIds(comments: readonly IssueComment[]) {
  return comments
    .filter((comment) => !("clientStatus" in comment) || !comment.clientStatus)
    .map((comment) => comment.id)
    .sort();
}

/**
 * Warm the input facts of the recent comments already in cache, under the
 * batch keys that `useIssueIdBatches` reads in the chat.
 */
export function prefetchIssueCommentInputFacts(queryClient: QueryClient, issueRef: string, staleTime: number) {
  const recent = queryClient.getQueryData<IssueRecentComments>([...queryKeys.issues.comments(issueRef), "recent"]);
  return prefetchIssueIdBatches(
    queryClient,
    issueCommentInputFactsQueryKey(issueRef),
    issueInputCommentIds(recent?.comments ?? []),
    (ids) => activityApi.inputFactsForIssue(issueRef, ids),
    staleTime,
  );
}

/** Recent activity, merged with events already observed while the task is open. */
export async function fetchRecentIssueActivity(queryClient: QueryClient, issueRef: string) {
  const recent = await activityApi.recentForIssue(issueRef);
  const previous = queryClient.getQueryData<ActivityEvent[]>(recentIssueActivityQueryKey(issueRef)) ?? [];
  return [...new Map([...previous, ...recent].map((event) => [event.id, event])).values()];
}

/** The latest run, plus every run observed while the task is open. */
export async function fetchRecentIssueRunWindow(
  queryClient: QueryClient,
  issueRef: string,
  options: { conversationMode?: boolean } = {},
): Promise<RecentIssueRunWindow> {
  const key = recentIssueRunWindowQueryKey(issueRef);
  let recent = await activityApi.recentRunsForIssue(issueRef);
  const previousWindow = queryClient.getQueryData<RecentIssueRunWindow>(key);
  let previous = previousWindow?.runs ?? [];
  let reconciledFullHistory = false;
  if (previous.some((run) =>
    (run.status === "running" || run.status === "queued") && !recent.some((next) => next.runId === run.runId),
  )) {
    // After a reconnect, several turns may have completed beyond the small
    // window. Reconcile watched runs once against authoritative summaries.
    recent = options.conversationMode
      ? await activityApi.runsByIdsForIssue(issueRef, [...new Set([...previous.map(run => run.runId), ...recent.map(run => run.runId)])])
      : await activityApi.runsForIssue(issueRef);
    reconciledFullHistory = true;
    const existingRunIds = new Set(recent.map((run) => run.runId));
    previous = previous.filter((run) => existingRunIds.has(run.runId));
  }
  return buildRecentIssueRunWindow(recent, previous, !reconciledFullHistory && previousWindow?.hasEarlierRuns === true);
}

/**
 * The run window for a `/runs?view=recent` answer. `previous` holds runs
 * already observed while the task is open; a cold open passes none.
 */
export function buildRecentIssueRunWindow(
  recent: RunForIssue[],
  previous: RunForIssue[] = [],
  previouslyHadEarlierRuns = false,
): RecentIssueRunWindow {
  // The second row refreshes a just-finished predecessor. Start with only
  // the latest run, then keep every run observed while this task is open.
  const visible = new Set([...previous.map((run) => run.runId), ...recent.slice(0, 1).map((run) => run.runId)]);
  return {
    runs: [...new Map([...previous, ...recent].filter((run) => visible.has(run.runId)).map((run) => [run.runId, run])).values()],
    // A first run is already visible. The disclosure needs evidence of an
    // omitted run, and must retain that evidence as later turns arrive.
    hasEarlierRuns: recent.some((run) => !visible.has(run.runId))
      || (recent.length >= 2 && previouslyHadEarlierRuns),
  };
}

/** Prefetched answers for live state stay usable only briefly. */
const LIVE_STATE_PREFETCH_STALE_TIME_MS = 5_000;

/**
 * Warm the reads that gate the compact chat's first frame, so a task the person
 * is about to open renders from cache. Comments and the core issue are warmed by
 * `prefetchIssueDetailForNavigation`; this adds the rest of the gate.
 */
export function prefetchIssueChatHistory(
  queryClient: QueryClient,
  issueRef: string,
  options: {
    issue?: Pick<Issue, "status" | "executionRunId" | "conversationAgentId"> | null;
    staleTime: number;
  },
) {
  const { staleTime } = options;
  // Same mode as the page, so a reconnect reconciles only the watched runs.
  const conversationMode = !!options.issue?.conversationAgentId;
  const reads: Promise<unknown>[] = [
    queryClient.prefetchQuery({
      queryKey: recentIssueActivityQueryKey(issueRef),
      queryFn: () => fetchRecentIssueActivity(queryClient, issueRef),
      staleTime,
    }),
    queryClient.prefetchQuery({
      queryKey: recentIssueRunWindowQueryKey(issueRef),
      queryFn: () => fetchRecentIssueRunWindow(queryClient, issueRef, { conversationMode }),
      staleTime,
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.issues.interactions(issueRef),
      queryFn: () => issuesApi.listInteractions(issueRef),
      staleTime,
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.issues.attachments(issueRef),
      queryFn: () => issuesApi.listAttachments(issueRef),
      staleTime,
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.issues.liveRuns(issueRef),
      queryFn: () => heartbeatsApi.liveRunsForIssue(issueRef),
      staleTime: LIVE_STATE_PREFETCH_STALE_TIME_MS,
    }),
  ];
  // The page reads the active run only for work that is running.
  if (options.issue && (options.issue.executionRunId || options.issue.status === "in_progress")) {
    reads.push(queryClient.prefetchQuery({
      queryKey: queryKeys.issues.activeRun(issueRef),
      queryFn: () => heartbeatsApi.activeRunForIssue(issueRef),
      staleTime: LIVE_STATE_PREFETCH_STALE_TIME_MS,
    }));
  }
  return Promise.all(reads);
}
