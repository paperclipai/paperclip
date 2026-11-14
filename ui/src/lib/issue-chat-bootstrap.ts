import type { QueryClient, QueryKey } from "@tanstack/react-query";
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
/**
 * How long a page read waits for a loading bootstrap before it reads the
 * server itself. A stalled bootstrap must not keep the chat (or its Retry)
 * from loading.
 */
export const CHAT_BOOTSTRAP_SHARE_DEADLINE_MS = 5_000;

/**
 * The account a request was sent for: a user id, `null` when the session has
 * no user, or `undefined` while this document has not read its session yet.
 * `revoked` marks a request whose answer must never be used.
 */
type Owner = { account: string | null | undefined; revoked: boolean };

/** One task's part of a bootstrap request. It is never used by another account. */
type Entry = { promise: Promise<ChatBootstrapItem | undefined>; owner: Owner; startedAt: number; settledAt?: number };
const entries = new Map<string, Entry>();

function refKey(ref: string) {
  return /^[0-9a-f-]{36}$/i.test(ref) ? ref.toLowerCase() : ref.toUpperCase();
}

/** The session's user id, `null` without a user, `undefined` before the first session read. */
function sessionAccount(queryClient: QueryClient): string | null | undefined {
  const session = queryClient.getQueryState<{ user?: { id?: unknown } | null } | null>(queryKeys.auth.session)?.data;
  if (session === undefined) return undefined;
  return typeof session?.user?.id === "string" ? session.user.id : null;
}

/**
 * Whether `owner`'s answer may be used now. A request sent before the first
 * session read (a hard load's early fetch) can only have used this
 * document's original sign-in, so it belongs to the first account the
 * session reports; a session without a user revokes it.
 */
function ownerMatches(owner: Owner, current: string | null | undefined) {
  if (owner.revoked) return false;
  if (owner.account !== undefined) return owner.account === current;
  if (current === undefined) return true;
  if (current === null) {
    owner.revoked = true;
    return false;
  }
  owner.account = current;
  return true;
}

/** Owners sent before the first session read, bound as soon as the session is known. */
const pendingOwners = new Set<Owner>();
let stopWatchingSession: (() => void) | null = null;

function newOwner(queryClient: QueryClient): Owner {
  const owner: Owner = { account: sessionAccount(queryClient), revoked: false };
  if (owner.account !== undefined) return owner;
  pendingOwners.add(owner);
  stopWatchingSession ??= queryClient.getQueryCache().subscribe(() => {
    const current = sessionAccount(queryClient);
    if (current === undefined) return;
    // Bind (or, for a session without a user, revoke) before anything else
    // can sign in, so a later account never inherits these answers.
    for (const pending of pendingOwners) ownerMatches(pending, current);
    pendingOwners.clear();
    stopWatchingSession?.();
    stopWatchingSession = null;
  });
  return owner;
}

function isExpired(entry: Entry, now: number) {
  return entry.settledAt !== undefined && now - entry.settledAt >= ISSUE_CHAT_BOOTSTRAP_FRESH_MS;
}

/** This account's entry for `ref` that is loading or loaded recently. */
function currentEntry(queryClient: QueryClient, ref: string, now = Date.now()) {
  const entry = entries.get(refKey(ref));
  if (!entry || isExpired(entry, now)) return undefined;
  return ownerMatches(entry.owner, sessionAccount(queryClient)) ? entry : undefined;
}

/** Remove `entry` from every ref that still points at it. */
function forget(entry: Entry) {
  for (const [key, value] of entries) if (value === entry) entries.delete(key);
}

/**
 * Track one task's part of a request under every ref it is known by: the
 * refs the caller gave at once, and the task's id and identifier when the
 * answer arrives. A list (identifiers) and Recents (ids) then never load the
 * same task twice, even while a request is in flight. Expired entries are
 * dropped, so answers do not stay in memory.
 */
function track(queryClient: QueryClient, refs: readonly string[], owner: Owner, startedAt: number, promise: Promise<ChatBootstrapItem | undefined>) {
  const now = Date.now();
  for (const [key, entry] of entries) if (isExpired(entry, now)) entries.delete(key);
  const entry: Entry = { startedAt, owner, promise };
  for (const ref of refs) entries.set(refKey(ref), entry);
  void promise.then((item) => {
    entry.settledAt = Date.now();
    if (!item) {
      // A failed or empty answer must not suppress later reads or preloads.
      forget(entry);
      return;
    }
    for (const alias of [item.issue.id, item.issue.identifier]) {
      if (alias && !currentEntry(queryClient, alias)) entries.set(refKey(alias), entry);
    }
  });
}

/** One task to request: the ref sent to the server, plus every ref it is known by. */
type Wanted = { ref: string; refs: string[] };

function startChunk(queryClient: QueryClient, companyId: string, wanted: readonly Wanted[]) {
  const refs = wanted.map((target) => target.ref);
  const requestedAt = Date.now();
  const owner = newOwner(queryClient);
  // A synchronous throw (bad input) is only a missed preload as well.
  const request = Promise.resolve().then(() => issuesApi.chatBootstrap(companyId, refs)).then((response) => {
    const byRef = new Map<string, ChatBootstrapItem>();
    // Never seed or share an answer read with the previous account's cookie.
    if (!ownerMatches(owner, sessionAccount(queryClient))) return byRef;
    for (const item of response.items) {
      if (!seedIssueChatBootstrap(queryClient, item, { companyId, requestedAt })) continue;
      byRef.set(refKey(item.ref), item);
    }
    return byRef;
  });
  for (const target of wanted) {
    track(queryClient, target.refs, owner, requestedAt, request.then((byRef) => byRef.get(refKey(target.ref)), () => undefined));
  }
  return request.then(() => undefined, () => undefined);
}

/**
 * How long a background preload (a task list) skips a task it already
 * preloaded. A list that stays open re-renders as live events reorder it;
 * events keep a preloaded task's cache current or mark it stale, so the list
 * does not need to preload the same task again every 30 seconds.
 */
export const CHAT_BOOTSTRAP_BACKGROUND_REPEAT_MS = 5 * 60_000;
const backgroundPreloadedAt = new Map<string, number>();

function preloadedInBackgroundRecently(refs: readonly string[], now: number) {
  return refs.some((ref) => {
    const at = backgroundPreloadedAt.get(refKey(ref));
    return at !== undefined && now - at < CHAT_BOOTSTRAP_BACKGROUND_REPEAT_MS;
  });
}

function rememberBackgroundPreload(refs: readonly string[], now: number) {
  for (const [key, at] of backgroundPreloadedAt) if (now - at >= CHAT_BOOTSTRAP_BACKGROUND_REPEAT_MS) backgroundPreloadedAt.delete(key);
  for (const ref of refs) backgroundPreloadedAt.set(refKey(ref), now);
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
 * `background` (a list's preload) also skips tasks it preloaded within
 * `CHAT_BOOTSTRAP_BACKGROUND_REPEAT_MS`.
 */
export async function loadIssueChatBootstraps(
  queryClient: QueryClient,
  companyId: string,
  targets: readonly ChatBootstrapTarget[],
  options: { signal?: AbortSignal; background?: boolean } = {},
) {
  const now = Date.now();
  // Keyed by the normalized ref; the request keeps the caller's spelling.
  const wanted = new Map<string, Wanted>();
  for (const target of targets) {
    const refs = typeof target === "string" ? [target] : [target.id, target.identifier].filter((ref): ref is string => !!ref);
    if (!refs.length || wanted.has(refKey(refs[0]!))) continue;
    if (refs.some((ref) => currentEntry(queryClient, ref, now))) continue;
    if (hasFreshIssueChatFirstFrame(queryClient, refs, now)) continue;
    if (options.background && preloadedInBackgroundRecently(refs, now)) continue;
    wanted.set(refKey(refs[0]!), { ref: refs[0]!, refs });
  }
  const ordered = [...wanted.values()];
  for (let start = 0; start < ordered.length; start += ISSUE_CHAT_BOOTSTRAP_MAX_IDS) {
    if (options.signal?.aborted) return;
    const chunk = ordered.slice(start, start + ISSUE_CHAT_BOOTSTRAP_MAX_IDS);
    if (options.background) rememberBackgroundPreload(chunk.flatMap((target) => target.refs), Date.now());
    await startChunk(queryClient, companyId, chunk);
  }
}

/** Set by the inline script; `startedAt` is the request's `Date.now()`. */
type EarlyChatBootstrap = { ref: string; startedAt?: number; promise: Promise<ChatBootstrapItem | null> };

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
  // Staleness counts from when the server could last have read the task.
  const startedAt = typeof early.startedAt === "number" ? early.startedAt : Date.now();
  // A page that took this long to start reads the task itself.
  if (Date.now() - startedAt >= ISSUE_CHAT_BOOTSTRAP_FRESH_MS) return false;
  const owner = newOwner(queryClient);
  track(queryClient, [ref], owner, startedAt, early.promise.then((item) => {
    // The answer belongs to the account that loaded the page.
    if (!item?.issue || !ownerMatches(owner, sessionAccount(queryClient))) return undefined;
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
  const owner = newOwner(queryClient);
  const path = `/issues/${encodeURIComponent(ref)}/chat-bootstrap`;
  track(queryClient, [ref], owner, requestedAt, Promise.resolve().then(() => api.get<ChatBootstrapItem>(path, { cache: "no-store" })).then((item) => {
    if (!item?.issue || !ownerMatches(owner, sessionAccount(queryClient))) return undefined;
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
  const settled = () => currentEntry(queryClient, ref)?.promise ?? Promise.resolve();
  if (currentEntry(queryClient, ref)) return settled();
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
 * For a task page's first read of `key`: when this account's bootstrap for
 * the task is loading or just arrived, use its part of the answer instead of
 * sending another request. A key that already holds data is being refreshed
 * (after a write, an invalidation or a poll), so it always asks the server.
 * Falls back to the normal read when there is no bootstrap, or it lacks the task.
 */
export async function readFromIssueChatBootstrap<T>(
  queryClient: QueryClient,
  key: QueryKey,
  ref: string,
  pick: (item: ChatBootstrapItem) => T | undefined,
  read: () => Promise<T>,
): Promise<T> {
  if (queryClient.getQueryData(key) !== undefined) return read();
  const entry = currentEntry(queryClient, ref);
  // Only share an answer that is still loading or a moment old.
  if (entry && (entry.settledAt === undefined || Date.now() - entry.settledAt < SHARE_WINDOW_MS)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<"stalled">((resolve) => { timer = setTimeout(() => resolve("stalled"), CHAT_BOOTSTRAP_SHARE_DEADLINE_MS); });
    const answer = await Promise.race([entry.promise, stalled]);
    clearTimeout(timer);
    if (answer === "stalled") {
      // Later reads (and Retry) go to the server instead of the stuck request.
      forget(entry);
      return read();
    }
    const item = answer;
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
  backgroundPreloadedAt.clear();
  pendingOwners.clear();
  stopWatchingSession?.();
  stopWatchingSession = null;
}

/** Test seam: how many refs hold an entry. */
export function issueChatBootstrapEntryCountForTest() {
  return entries.size;
}
