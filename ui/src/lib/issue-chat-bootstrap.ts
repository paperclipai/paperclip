import type { QueryClient } from "@tanstack/react-query";
import { ISSUE_CHAT_BOOTSTRAP_MAX_IDS, type IssueChatBootstrap, type IssueChatBootstrapItem } from "@paperclipai/shared";
import { api } from "@/api/client";
import type { RunForIssue } from "@/api/activity";
import type { ActiveRunForIssue, LiveRunForIssue } from "@/api/heartbeats";
import { seedIssueIdBatches } from "@/hooks/useIssueIdBatches";
import {
  issueCommentInputFactsQueryKey,
  issueInputCommentIds,
  recentIssueActivityQueryKey,
  recentIssueRunWindowQueryKey,
  type RecentIssueRunWindow,
} from "@/lib/issue-chat-history-queries";
import { seedIssueDetailProjections } from "@/lib/issueDetailCache";
import { EARLY_CHAT_BOOTSTRAP_GLOBAL } from "@/lib/issue-detail-preload-events";
import { queryKeys } from "@/lib/queryKeys";

// A task opens instantly when everything its chat reads before the first frame
// is already cached. One bootstrap request returns those reads for up to ten
// tasks, in the shapes of the per-task endpoints, and this module writes them
// under the exact keys the task page reads.
//
// - The task list preloads its top rows in the background.
// - A cold open (direct link, or a task that was not preloaded) starts one
//   bootstrap for that task, and the page's own reads wait for it instead of
//   sending about ten requests of their own.

export type ChatBootstrapItem = IssueChatBootstrapItem<RunForIssue, LiveRunForIssue, ActiveRunForIssue>;

/** How long a preloaded task counts as fresh enough to skip reloading it. */
export const CHAT_BOOTSTRAP_FRESH_MS = 30_000;
/** How many top rows of a task list are preloaded. */
export const CHAT_BOOTSTRAP_PRELOAD_LIMIT = 30;

export const chatBootstrapApi = {
  get: (companyId: string, refs: readonly string[], options?: { signal?: AbortSignal }) =>
    api.get<IssueChatBootstrap<RunForIssue, LiveRunForIssue, ActiveRunForIssue>>(
      `/companies/${encodeURIComponent(companyId)}/issues/chat-bootstrap?ids=${refs.map(encodeURIComponent).join(",")}`,
      options,
    ),
};

type Entry = { promise: Promise<ChatBootstrapItem | undefined>; startedAt: number; settledAt?: number };
const entries = new Map<string, Entry>();

function refKey(ref: string) {
  return /^[0-9a-f-]{36}$/i.test(ref) ? ref.toLowerCase() : ref.toUpperCase();
}

/** Write `data` unless the cache already holds a newer answer. */
function seedReplace(queryClient: QueryClient, key: readonly unknown[], data: unknown, fetchedAt: number) {
  const state = queryClient.getQueryState(key);
  if (state?.data !== undefined && state.dataUpdatedAt >= fetchedAt) return;
  queryClient.setQueryData(key, data, { updatedAt: fetchedAt });
}

/** Write `data` only when nothing is cached: the page's own read merges with what it saw before. */
function seedIfAbsent(queryClient: QueryClient, key: readonly unknown[], data: unknown, fetchedAt: number) {
  if (queryClient.getQueryData(key) !== undefined) return;
  queryClient.setQueryData(key, data, { updatedAt: fetchedAt });
}

/** The window `fetchRecentIssueRunWindow` builds when nothing was observed before. */
function firstRunWindow(recent: RunForIssue[]): RecentIssueRunWindow {
  return { runs: recent.slice(0, 1), hasEarlierRuns: recent.length > 1 };
}

export function seedIssueChatBootstrap(queryClient: QueryClient, item: ChatBootstrapItem, fetchedAt = Date.now()) {
  const { issue } = item;
  const refs = [...new Set([item.ref, issue.id, issue.identifier].filter((ref): ref is string => !!ref))];
  seedIssueDetailProjections(queryClient, issue, item.ref);
  const inputIds = issueInputCommentIds(item.recentComments.comments);
  for (const ref of refs) {
    seedReplace(queryClient, [...queryKeys.issues.detail(ref), "core"], issue, fetchedAt);
    seedIfAbsent(queryClient, [...queryKeys.issues.comments(ref), "recent"], item.recentComments, fetchedAt);
    seedIfAbsent(queryClient, recentIssueActivityQueryKey(ref), item.recentActivity, fetchedAt);
    seedIfAbsent(queryClient, recentIssueRunWindowQueryKey(ref), firstRunWindow(item.recentRuns), fetchedAt);
    seedReplace(queryClient, queryKeys.issues.interactions(ref), item.interactions, fetchedAt);
    seedReplace(queryClient, queryKeys.issues.attachments(ref), item.attachments, fetchedAt);
    seedReplace(queryClient, queryKeys.issues.liveRuns(ref), item.liveRuns, fetchedAt);
    seedReplace(queryClient, queryKeys.issues.activeRun(ref), item.activeRun, fetchedAt);
    seedIssueIdBatches(queryClient, issueCommentInputFactsQueryKey(ref), inputIds, item.commentInputFacts, fetchedAt);
  }
}

/**
 * Load the bootstrap for these tasks in requests of at most ten, one request
 * at a time, and seed the cache as each one arrives. Tasks loaded within
 * `CHAT_BOOTSTRAP_FRESH_MS`, or already loading, are skipped.
 */
export async function loadIssueChatBootstraps(
  queryClient: QueryClient,
  companyId: string,
  refs: readonly string[],
  options: { signal?: AbortSignal } = {},
) {
  const now = Date.now();
  const wanted = [...new Set(refs.map(refKey))].filter((ref) => {
    const entry = entries.get(ref);
    return !entry || (entry.settledAt !== undefined && now - entry.settledAt > CHAT_BOOTSTRAP_FRESH_MS);
  });
  for (let start = 0; start < wanted.length; start += ISSUE_CHAT_BOOTSTRAP_MAX_IDS) {
    if (options.signal?.aborted) return;
    await startChunk(queryClient, companyId, wanted.slice(start, start + ISSUE_CHAT_BOOTSTRAP_MAX_IDS), options.signal);
  }
}

function startChunk(queryClient: QueryClient, companyId: string, refs: string[], signal?: AbortSignal) {
  const startedAt = Date.now();
  const request = chatBootstrapApi.get(companyId, refs, { signal }).then((response) => {
    const fetchedAt = Date.now();
    const byRef = new Map<string, ChatBootstrapItem>();
    for (const item of response.items) {
      seedIssueChatBootstrap(queryClient, item, fetchedAt);
      byRef.set(refKey(item.ref), item);
    }
    return byRef;
  });
  for (const ref of refs) {
    const promise = request.then((byRef) => byRef.get(ref), () => undefined);
    const entry: Entry = { startedAt, promise };
    void promise.then((item) => {
      entry.settledAt = Date.now();
      // A failed or empty answer must not suppress later reads or preloads.
      if (!item && entries.get(ref) === entry) entries.delete(ref);
    });
    entries.set(ref, entry);
  }
  return request.then(() => undefined, () => undefined);
}

/**
 * Adopt the fetch the page's inline script started on a hard load of this task
 * (see `vite-issue-detail-preload`), so the first answer needs no new request.
 */
function adoptEarlyChatBootstrap(queryClient: QueryClient, ref: string) {
  if (typeof window === "undefined") return false;
  const early = (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] as
    | { ref: string; promise: Promise<ChatBootstrapItem | null> }
    | undefined;
  if (!early || refKey(early.ref) !== refKey(ref)) return false;
  delete (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL];
  const promise = early.promise.then((item) => {
    if (!item) return undefined;
    seedIssueChatBootstrap(queryClient, item);
    return item;
  }, () => undefined);
  const entry: Entry = { startedAt: Date.now(), promise };
  void promise.then((item) => {
    entry.settledAt = Date.now();
    if (!item && entries.get(refKey(ref)) === entry) entries.delete(refKey(ref));
  });
  entries.set(refKey(ref), entry);
  return true;
}

/** Start a single-task bootstrap for a cold open, unless one is fresh or loading. */
export function startIssueChatBootstrap(queryClient: QueryClient, companyId: string | null | undefined, ref: string | null | undefined) {
  if (!ref) return;
  const current = entries.get(refKey(ref));
  if (current && (current.settledAt === undefined || Date.now() - current.settledAt < CHAT_BOOTSTRAP_FRESH_MS)) return;
  if (adoptEarlyChatBootstrap(queryClient, ref)) return;
  if (!companyId) return;
  void loadIssueChatBootstraps(queryClient, companyId, [ref]);
}

/**
 * For a task page read: when a bootstrap for this task is loading or just
 * arrived, use its part of the answer instead of sending another request.
 * Falls back to the normal read when there is none, or it lacks the task.
 */
export async function readFromIssueChatBootstrap<T>(
  ref: string,
  pick: (item: ChatBootstrapItem) => T | undefined,
  read: () => Promise<T>,
): Promise<T> {
  const entry = entries.get(refKey(ref));
  // Only share an answer that is still loading or a moment old; later reads
  // are refreshes and must ask the server.
  if (entry && (entry.settledAt === undefined || Date.now() - entry.settledAt < 2_000)) {
    const item = await entry.promise;
    const value = item ? pick(item) : undefined;
    if (value !== undefined) return value;
  }
  return read();
}

/** Whether two sorted id lists are the same set. */
export function sameIds(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Test seam. */
export function resetIssueChatBootstrapsForTest() {
  entries.clear();
}
