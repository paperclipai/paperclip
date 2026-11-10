/**
 * The task chat bootstrap started by the inline script in `ui/index.html` on a
 * hard load of a task URL, before the app's JavaScript loads.
 *
 * Two consumers read it:
 * - `primeTaskChatBootstrapPreload` (lib/issueChatBootstrapCache) seeds the
 *   task page's query caches when the response arrives.
 * - The API client's GET coalescing (`takePreloadedGet`): a first-frame GET
 *   issued while the bootstrap is still in flight waits for it and receives
 *   the matching field instead of making its own request. A missing field, a
 *   failed bootstrap or a request outside the fresh window falls back to the
 *   network. Each path is answered at most once, so refetches (invalidations,
 *   the socket's catch-up) always reach the server.
 *
 * Kept free of app imports: the API client depends on it.
 */

/** How long the preloaded answers may stand in for a request: the app's query stale time. */
export const TASK_CHAT_BOOTSTRAP_PRELOAD_FRESH_MS = 30_000;

/**
 * How long reads wait for a bootstrap that has not answered before making
 * their own requests. Below the API client's 15-second request deadline, so a
 * stalled bootstrap still ends in the same per-read Retry states.
 */
export const TASK_CHAT_BOOTSTRAP_PRELOAD_WAIT_MS = 8_000;

/** What the inline script leaves on `window`. */
export interface TaskChatBootstrapPreloadGlobal {
  ref: string;
  pathname: string;
  requestedAt: number;
  response: Promise<unknown>;
}

/** A bootstrap item as far as this module needs to know it. */
export interface TaskChatBootstrapPreloadItem {
  ref: string;
  issue: { id: string; identifier?: string | null; companyId: string };
  [field: string]: unknown;
}

export interface TaskChatBootstrapPreload {
  ref: string;
  pathname: string;
  requestedAt: number;
  /** Resolves to the bootstrap item, or null when the request failed or was unusable. */
  item: Promise<TaskChatBootstrapPreloadItem | null>;
}

type PreloadWindow = { __PAPERCLIP_TASK_CHAT_BOOTSTRAP__?: TaskChatBootstrapPreloadGlobal };

/** Each first-frame GET path suffix (after `/issues/:ref`) and the bootstrap field that answers it. */
const FIELD_BY_SUFFIX: ReadonlyArray<readonly [suffix: string, field: string]> = [
  ["?view=core", "issue"],
  ["/recent-comments", "recentComments"],
  ["/activity?view=recent", "recentActivity"],
  ["/runs?view=recent", "recentRuns"],
  ["/interactions", "interactions"],
  ["/attachments", "attachments"],
  ["/live-runs", "liveRuns"],
  ["/active-run", "activeRun"],
];

let preload: TaskChatBootstrapPreload | null | undefined;
const answered = new Set<string>();
let now: () => number = () => Date.now();
let waitMs = TASK_CHAT_BOOTSTRAP_PRELOAD_WAIT_MS;

function isItem(value: unknown): value is TaskChatBootstrapPreloadItem {
  if (!value || typeof value !== "object") return false;
  const issue = (value as { issue?: unknown }).issue;
  return !!issue && typeof issue === "object"
    && typeof (issue as { id?: unknown }).id === "string"
    && typeof (issue as { companyId?: unknown }).companyId === "string";
}

/**
 * The preload for this page load, read once from `window` (`globalThis`). Returns null when
 * there is none, it belongs to another path, or it was discarded.
 */
export function readTaskChatBootstrapPreload(target: PreloadWindow = globalThis as PreloadWindow) {
  if (preload !== undefined) return preload;
  const raw = target.__PAPERCLIP_TASK_CHAT_BOOTSTRAP__;
  delete target.__PAPERCLIP_TASK_CHAT_BOOTSTRAP__;
  if (!raw || typeof raw.ref !== "string" || typeof raw.requestedAt !== "number" || !raw.response) {
    preload = null;
    return preload;
  }
  preload = {
    ref: raw.ref,
    pathname: raw.pathname,
    requestedAt: raw.requestedAt,
    item: new Promise<TaskChatBootstrapPreloadItem | null>((resolve) => {
      const deadline = setTimeout(() => resolve(null), Math.max(0, raw.requestedAt + waitMs - now()));
      Promise.resolve(raw.response).then(
        (body) => resolve(isItem(body) ? body : null),
        () => resolve(null),
      ).finally(() => clearTimeout(deadline));
    }),
  };
  return preload;
}

/** Drop the preload, for example when the account changes. */
export function discardTaskChatBootstrapPreload() {
  preload = null;
  answered.clear();
}

function matchField(path: string, ref: string) {
  const prefix = `/issues/${ref}`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  return FIELD_BY_SUFFIX.find(([suffix]) => suffix === rest)?.[1] ?? null;
}

/**
 * For a first-frame GET of the preloaded task, a promise of the bootstrap's
 * answer: `hit` with the field's value, or a miss when the request should go
 * to the network instead. Returns null for every other path.
 */
export function takePreloadedGet(path: string): Promise<{ hit: true; value: unknown } | { hit: false }> | null {
  const current = readTaskChatBootstrapPreload();
  if (!current || answered.has(path)) return null;
  if (now() - current.requestedAt > TASK_CHAT_BOOTSTRAP_PRELOAD_FRESH_MS) return null;
  // Only the URL ref is known before the response. Reads by id or canonical
  // identifier start after it, when the seeded caches already answer them.
  const field = matchField(path, current.ref);
  if (!field) return null;
  answered.add(path);
  return current.item.then((item) => {
    if (!item || preload !== current || now() - current.requestedAt > TASK_CHAT_BOOTSTRAP_PRELOAD_FRESH_MS) return { hit: false as const };
    const value = item[field];
    // A missing field is unknown, not empty; `null` (no active run) is an answer.
    return value === undefined ? { hit: false as const } : { hit: true as const, value };
  });
}

/** Test seam: reset module state and optionally fix the clock and the wait. */
export function resetTaskChatBootstrapPreloadForTests(options: { now?: () => number; waitMs?: number } = {}) {
  preload = undefined;
  answered.clear();
  now = options.now ?? (() => Date.now());
  waitMs = options.waitMs ?? TASK_CHAT_BOOTSTRAP_PRELOAD_WAIT_MS;
}
