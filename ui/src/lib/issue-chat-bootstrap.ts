import type { QueryClient } from "@tanstack/react-query";
import { ISSUE_CHAT_BOOTSTRAP_MAX_IDS } from "@paperclipai/shared";
import { api } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { EARLY_CHAT_BOOTSTRAP_GLOBAL } from "@/lib/issue-detail-preload-events";
import { queryKeys } from "@/lib/queryKeys";
import {
  hasFreshIssueChatFirstFrame,
  ISSUE_CHAT_BOOTSTRAP_FRESH_MS,
  seedIssueChatBootstrap,
  type IssueChatBootstrapEntry,
} from "@/lib/issueChatBootstrapCache";

// A task opens instantly when everything its chat reads before the first frame
// is already cached. One bootstrap request returns those reads for up to ten
// tasks, in the shapes of the per-task endpoints, and `issueChatBootstrapCache`
// writes them under the exact keys the task page reads. This module decides
// when to send that request and lets the page's reads share it:
//
// - Task lists and the sidebar's Recents preload their top rows in the background.
// - A cold open (direct link, or a task that was not preloaded) starts one
//   bootstrap for that task, and the page's gating reads wait for it instead of
//   sending about ten requests of their own.
// - A hard load of a task URL adopts the fetch the HTML started (see
//   `vite-issue-detail-preload`).

export type ChatBootstrapItem = IssueChatBootstrapEntry;

/**
 * How many top rows of a task list are preloaded: one request. Each task
 * costs the server about fifty queries, and a resting hover warms any other
 * row before it is clicked.
 */
export const CHAT_BOOTSTRAP_PRELOAD_LIMIT = ISSUE_CHAT_BOOTSTRAP_MAX_IDS;
/** How long after it arrives a bootstrap answer may stand in for a page read. */
const SHARE_WINDOW_MS = 2_000;

type Entry = { promise: Promise<ChatBootstrapItem | undefined>; startedAt: number; settledAt?: number };
const entries = new Map<string, Entry>();

function refKey(ref: string) {
  return /^[0-9a-f-]{36}$/i.test(ref) ? ref.toLowerCase() : ref.toUpperCase();
}

function isCurrent(entry: Entry | undefined, now = Date.now()) {
  return !!entry && (entry.settledAt === undefined || now - entry.settledAt < ISSUE_CHAT_BOOTSTRAP_FRESH_MS);
}

/**
 * Track one task's part of a request under the ref it was asked by. When the
 * answer arrives it is also recorded under the task's id and identifier, so a
 * list (identifiers) and Recents (ids) never load the same task twice.
 */
function track(ref: string, startedAt: number, promise: Promise<ChatBootstrapItem | undefined>) {
  const entry: Entry = { startedAt, promise };
  entries.set(refKey(ref), entry);
  void promise.then((item) => {
    entry.settledAt = Date.now();
    if (!item) {
      // A failed or empty answer must not suppress later reads or preloads.
      if (entries.get(refKey(ref)) === entry) entries.delete(refKey(ref));
      return;
    }
    for (const alias of [item.issue.id, item.issue.identifier]) {
      if (alias && !isCurrent(entries.get(refKey(alias)))) entries.set(refKey(alias), entry);
    }
  });
}

/** The signed-in user, or null for a local board. */
function sessionUserId(queryClient: QueryClient) {
  const session = queryClient.getQueryData<{ user?: { id?: unknown } | null } | null>(queryKeys.auth.session);
  return typeof session?.user?.id === "string" ? session.user.id : null;
}

function startChunk(queryClient: QueryClient, companyId: string, refs: string[]) {
  const requestedAt = Date.now();
  const userId = sessionUserId(queryClient);
  // A synchronous throw (bad input) is only a missed preload as well.
  const request = Promise.resolve().then(() => issuesApi.chatBootstrap(companyId, refs)).then((response) => {
    const byRef = new Map<string, ChatBootstrapItem>();
    // Never seed or share an answer read with the previous account's cookie.
    if (sessionUserId(queryClient) !== userId) return byRef;
    for (const item of response.items) {
      if (!seedIssueChatBootstrap(queryClient, item, { companyId, requestedAt })) continue;
      byRef.set(refKey(item.ref), item);
    }
    return byRef;
  });
  for (const ref of refs) track(ref, requestedAt, request.then((byRef) => byRef.get(refKey(ref)), () => undefined));
  return request.then(() => undefined, () => undefined);
}

/** A task to preload: a ref, or its id with the identifier it may also be cached under. */
export type ChatBootstrapTarget = string | { id: string; identifier: string | null };

/**
 * Load the bootstrap for these tasks in requests of at most ten, one request
 * at a time, and seed the cache as each one arrives. Tasks loading, loaded
 * within `ISSUE_CHAT_BOOTSTRAP_FRESH_MS`, or whose first frame is already cached
 * and fresh are skipped.
 *
 * `signal` stops later requests, never one in flight: a click that unmounts
 * the list must still be able to use the answer for the task it opens.
 */
export async function loadIssueChatBootstraps(
  queryClient: QueryClient,
  companyId: string,
  targets: readonly ChatBootstrapTarget[],
  options: { signal?: AbortSignal } = {},
) {
  const now = Date.now();
  // Keyed by the normalized ref; the request keeps the caller's spelling.
  const wanted = new Map<string, string>();
  for (const target of targets) {
    const refs = typeof target === "string" ? [target] : [target.id, target.identifier].filter((ref): ref is string => !!ref);
    if (!refs.length || wanted.has(refKey(refs[0]!))) continue;
    if (refs.some((ref) => isCurrent(entries.get(refKey(ref)), now))) continue;
    if (hasFreshIssueChatFirstFrame(queryClient, refs, now)) continue;
    wanted.set(refKey(refs[0]!), refs[0]!);
  }
  const ordered = [...wanted.values()];
  for (let start = 0; start < ordered.length; start += ISSUE_CHAT_BOOTSTRAP_MAX_IDS) {
    if (options.signal?.aborted) return;
    await startChunk(queryClient, companyId, ordered.slice(start, start + ISSUE_CHAT_BOOTSTRAP_MAX_IDS));
  }
}

type EarlyChatBootstrap = { ref: string; promise: Promise<ChatBootstrapItem | null> };

/**
 * Adopt the fetch the page's inline script started on a hard load of this task
 * (see `vite-issue-detail-preload`), so the first answer needs no new request.
 */
function adoptEarlyChatBootstrap(queryClient: QueryClient, companyId: string | null | undefined, ref: string) {
  if (typeof window === "undefined") return false;
  const holder = window as unknown as Record<string, EarlyChatBootstrap | undefined>;
  const early = holder[EARLY_CHAT_BOOTSTRAP_GLOBAL];
  if (!early || refKey(early.ref) !== refKey(ref)) return false;
  delete holder[EARLY_CHAT_BOOTSTRAP_GLOBAL];
  const startedAt = Date.now();
  track(ref, startedAt, early.promise.then((item) => {
    if (!item?.issue) return undefined;
    // The route's task is the one the page opens; a known company must match it.
    const ownerCompanyId = companyId ?? item.issue.companyId;
    return seedIssueChatBootstrap(queryClient, item, { companyId: ownerCompanyId, requestedAt: startedAt }) ? item : undefined;
  }, () => undefined));
  return true;
}

/**
 * The single-task route, for a task whose company the caller does not know
 * (a link's open intent). The task's own company owns the answer.
 */
function startSingle(queryClient: QueryClient, ref: string) {
  const requestedAt = Date.now();
  const userId = sessionUserId(queryClient);
  const path = `/issues/${encodeURIComponent(ref)}/chat-bootstrap`;
  track(ref, requestedAt, Promise.resolve().then(() => api.get<ChatBootstrapItem>(path, { cache: "no-store" })).then((item) => {
    if (!item?.issue || sessionUserId(queryClient) !== userId) return undefined;
    return seedIssueChatBootstrap(queryClient, item, { companyId: item.issue.companyId, requestedAt }) ? item : undefined;
  }, () => undefined));
}

/**
 * Start a single-task bootstrap for a cold open or an open intent, unless one
 * is loading, loaded recently, or the task's first frame is cached and fresh.
 * Without a company it uses the single-task route. Resolves when the task's
 * bootstrap (new or already loading) settles; it never rejects.
 */
export function startIssueChatBootstrap(
  queryClient: QueryClient,
  companyId: string | null | undefined,
  ref: string | null | undefined,
): Promise<unknown> {
  if (!ref) return Promise.resolve();
  const settled = () => entries.get(refKey(ref))?.promise ?? Promise.resolve();
  if (isCurrent(entries.get(refKey(ref)))) return settled();
  if (adoptEarlyChatBootstrap(queryClient, companyId, ref)) return settled();
  if (companyId) {
    void loadIssueChatBootstraps(queryClient, companyId, [ref]);
    return settled();
  }
  if (hasFreshIssueChatFirstFrame(queryClient, [ref])) return Promise.resolve();
  startSingle(queryClient, ref);
  return settled();
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
  if (entry && (entry.settledAt === undefined || Date.now() - entry.settledAt < SHARE_WINDOW_MS)) {
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
