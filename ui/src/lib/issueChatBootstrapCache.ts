import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { IssueChatBootstrap, IssueRecentComments } from "@paperclipai/shared";
import type { RunForIssue } from "@/api/activity";
import type { ActiveRunForIssue, LiveRunForIssue } from "@/api/heartbeats";
import { seedIssueIdBatch } from "@/hooks/useIssueIdBatches";
import { seedIssueDetailProjections } from "./issueDetailCache";
import {
  buildRecentIssueRunWindow,
  issueCommentInputFactsQueryKey,
  issueInputCommentIds,
  recentIssueActivityQueryKey,
  recentIssueRunWindowQueryKey,
} from "./issue-chat-history-queries";
import { queryKeys } from "./queryKeys";

export type IssueChatBootstrapResponse = IssueChatBootstrap<RunForIssue, LiveRunForIssue, ActiveRunForIssue>;
export type IssueChatBootstrapEntry = IssueChatBootstrapResponse["items"][number];

/** How long seeded first-frame data counts as fresh: the app's query stale time. */
export const ISSUE_CHAT_BOOTSTRAP_FRESH_MS = 30_000;

/** The reference the caller asked for, plus the task's id and identifier. */
function bootstrapRefs(item: Pick<IssueChatBootstrapEntry, "ref" | "issue">) {
  return [...new Set([item.ref, item.issue.id, item.issue.identifier].filter((ref): ref is string => !!ref))];
}

function coreKey(ref: string): QueryKey {
  return [...queryKeys.issues.detail(ref), "core"];
}

function recentCommentsKey(ref: string): QueryKey {
  return [...queryKeys.issues.comments(ref), "recent"];
}

function isFresh(queryClient: QueryClient, key: QueryKey, now: number) {
  const state = queryClient.getQueryState(key);
  return state?.data !== undefined && !state.isInvalidated && now - state.dataUpdatedAt < ISSUE_CHAT_BOOTSTRAP_FRESH_MS;
}

/**
 * True when every read that gates a task's first chat frame is cached and
 * fresh under one of its refs. A light warm (core issue and recent comments
 * only) is not a first frame: the task still needs the preload.
 */
export function hasFreshIssueChatFirstFrame(queryClient: QueryClient, refs: readonly string[], now = Date.now()) {
  return refs.some((ref) => {
    const keys = [
      coreKey(ref),
      recentCommentsKey(ref),
      recentIssueActivityQueryKey(ref),
      recentIssueRunWindowQueryKey(ref),
      queryKeys.issues.interactions(ref),
      queryKeys.issues.attachments(ref),
      queryKeys.issues.liveRuns(ref),
    ];
    if (!keys.every((key) => isFresh(queryClient, key, now))) return false;
    // The input facts of every saved recent comment, in the batches the chat reads.
    const comments = queryClient.getQueryData<IssueRecentComments>(recentCommentsKey(ref))?.comments ?? [];
    const factsKey = issueCommentInputFactsQueryKey(ref);
    const batches = queryClient.getQueryData<string[][]>([...factsKey, "batch-ids"]) ?? [];
    return issueInputCommentIds(comments).every((id) => {
      const batch = batches.find((ids) => ids.includes(id));
      return !!batch && isFresh(queryClient, [...factsKey, "batch", batch], now);
    });
  });
}

/**
 * Write `data` under `key` unless the cache holds something at least as new.
 *
 * A key with a read in flight or a pending invalidation is left to that read.
 * `replace` endpoints return the whole answer, so older cached data may be
 * replaced. The others merge what the open page observed (comments, activity,
 * runs), so only an empty key is filled.
 */
function seedKey(queryClient: QueryClient, key: QueryKey, data: unknown, requestedAt: number, replace: boolean) {
  // A missing field (an older server, or a partial answer) is not an empty answer.
  if (data === undefined) return false;
  const state = queryClient.getQueryState(key);
  if (state) {
    if (state.fetchStatus === "fetching" || state.isInvalidated) return false;
    if (state.data !== undefined && (!replace || state.dataUpdatedAt >= requestedAt)) return false;
  }
  // Stamped with the request time, not the arrival time, so staleness counts
  // from when the server could last have read the task.
  queryClient.setQueryData(key, data, { updatedAt: requestedAt });
  return true;
}

/**
 * Seed one chat-bootstrap item into the query keys the task page reads before
 * its first frame, under every reference the task can be opened by.
 *
 * The item's `issue` is the `?view=core` payload, so it fills the core key and
 * its projections, never the full detail key: core cannot stand in for the
 * detail read's related data. Items for another company are ignored.
 */
export function seedIssueChatBootstrap(
  queryClient: QueryClient,
  item: IssueChatBootstrapEntry,
  options: { companyId: string; requestedAt: number },
) {
  const { companyId, requestedAt } = options;
  if (!item?.issue || item.issue.companyId !== companyId) return false;
  const inputCommentIds = item.recentComments ? issueInputCommentIds(item.recentComments.comments) : [];
  for (const ref of bootstrapRefs(item)) {
    seedKey(queryClient, coreKey(ref), item.issue, requestedAt, true);
    seedKey(queryClient, recentCommentsKey(ref), item.recentComments, requestedAt, false);
    if (item.commentInputFacts !== undefined) {
      seedIssueIdBatch(queryClient, issueCommentInputFactsQueryKey(ref), inputCommentIds, item.commentInputFacts, requestedAt);
    }
    seedKey(
      queryClient,
      recentIssueActivityQueryKey(ref),
      item.recentActivity && [...new Map(item.recentActivity.map((event) => [event.id, event])).values()],
      requestedAt,
      false,
    );
    seedKey(
      queryClient,
      recentIssueRunWindowQueryKey(ref),
      item.recentRuns && buildRecentIssueRunWindow(item.recentRuns),
      requestedAt,
      false,
    );
    seedKey(queryClient, queryKeys.issues.interactions(ref), item.interactions, requestedAt, true);
    seedKey(queryClient, queryKeys.issues.attachments(ref), item.attachments, requestedAt, true);
    seedKey(queryClient, queryKeys.issues.liveRuns(ref), item.liveRuns, requestedAt, true);
    // `null` is an answer: the task has no active run.
    seedKey(queryClient, queryKeys.issues.activeRun(ref), item.activeRun, requestedAt, true);
  }
  // Plan document and work-product projections, filled only where empty.
  seedIssueDetailProjections(queryClient, item.issue, item.ref);
  return true;
}
