import { dehydrate, hashKey, hydrate, type DehydratedState, type Query, type QueryClient } from "@tanstack/react-query";
import { classifyError, isTransientError } from "@/api/errors";
import { detachInflightGets } from "@/api/client";
import { markCachedSession, verifyCachedSession, hasUnverifiedSession } from "./cached-session";
import { queryKeys } from "./queryKeys";
import { createUuid } from "./uuid";

export const QUERY_CACHE_PREFIX = "paperclip:query-cache:v1:";
export const QUERY_CACHE_ACTIVE = `${QUERY_CACHE_PREFIX}active`;
export const QUERY_CACHE_CLEARED = "paperclip:query-cache-cleared";
export const QUERY_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
export const QUERY_CACHE_MAX_ISSUES = 20;
const MAX_LINK_PREVIEWS = 100;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const REVISION_PREFIX = "paperclip:query-cache-revision:";
const controllers = new WeakMap<QueryClient, { clear: () => void }>();
/** Per client: each restored query's hash and the read time it was restored with. */
const restoredReads = new WeakMap<QueryClient, Map<string, number>>();
type CacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
type Envelope = { version: 1; userId: string; companyId: string | null; buildId: string; revision: string | null; savedAt: number; state: DehydratedState };
const object = (value: unknown): Record<string, unknown> | null => value != null && typeof value === "object" ? value as Record<string, unknown> : null;
const userIdOf = (value: unknown) => {
  const id = object(object(value)?.user)?.id;
  return typeof id === "string" && id ? id : null;
};
const recordKey = (userId: string, companyId: string | null) => `${QUERY_CACHE_PREFIX}${encodeURIComponent(userId)}:${companyId === null ? "root" : encodeURIComponent(companyId)}`;
const issueIdentity = (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => String(object(query.state.data)?.id ?? query.queryKey[2]).toLowerCase();
const issueRefs = (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => [query.queryKey[2], object(query.state.data)?.id, object(query.state.data)?.identifier]
  .filter((id): id is string => typeof id === "string").map(id => id.toLowerCase());
const excludedFields = new Set(["planDocument", "legacyPlanDocument", "documentSummaries", "documents", "comments", "workProducts", "browsers", "pairingCode", "viewerUrl", "accessToken", "refreshToken", "sessionToken", "token", "password", "apiKey", "privateKey", "authorization", "access_token", "refresh_token", "id_token", "clientSecret", "client_secret", "api_key", "private_key", "credentials", "env"].map(key => key.toLowerCase()));
// A saved task's chat keeps its comments (the owner approved saving recent
// comments on 2026-11-14); every other exclusion still applies.
const chatExcludedFields = new Set([...excludedFields].filter(key => key !== "comments"));
function displayData(value: unknown, denied: ReadonlySet<string>, excluded: ReadonlySet<string> = excludedFields): unknown {
  if (Array.isArray(value)) return value.map(item => displayData(item, denied, excluded)).filter(item => item !== undefined);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const row = value as Record<string, unknown>;
  if (typeof row.id === "string" && denied.has(row.id.toLowerCase())) return undefined;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.has(key.toLowerCase()))
    .map(([key, item]) => {
      if (key === "runtimeConfig") return [key, {}];
      if (key === "adapterConfig") {
        const config = object(item);
        return [key, Object.fromEntries(["provider", "model", "agent", "acpxAgent", "effort", "modelReasoningEffort", "reasoningEffort", "thinking", "variant"]
          .filter(field => typeof config?.[field] === "string").map(field => [field, config![field]]).concat(typeof config?.fastMode === "boolean" ? [["fastMode", config.fastMode]] : []))];
      }
      return [key, displayData(item, denied, excluded)];
    }));
}

function isLegacyInboxQuery(key: readonly unknown[]): boolean {
  const suffix = key[2] === "mine-by-me" || key[2] === "touched-by-me" ? key.slice(3) : key.slice(2);
  return key[0] === "issues" && suffix.length === 4 && suffix[0] === "compact"
    && suffix[1] === "with-routine-executions" && suffix[2] === "live-descendant-summary" && suffix[3] === 500;
}

function queryDisplayData(key: readonly unknown[], data: unknown, denied: ReadonlySet<string>): unknown {
  if (taskChatFirstFrameRef(key) !== null) return displayData(boundedChatData(key, data), denied, chatExcludedFields);
  return displayData(isLegacyInboxQuery(key) && Array.isArray(data) ? data.slice(0, 100) : data, denied);
}

/** Saved recent comments per task: the latest ones, enough for the first frame. */
export const SAVED_TASK_CHAT_MAX_COMMENTS = 50;
/** Saved chat bytes per task; a larger task opens through the bootstrap as before. */
export const SAVED_TASK_CHAT_MAX_TASK_BYTES = 192 * 1024;
/** Saved chat bytes per user across companies, newest tasks first. Keeps room for the rest of the cache. */
export const SAVED_TASK_CHAT_MAX_BYTES = 1024 * 1024;

/**
 * The task ref of a read that the first chat frame of a task waits for, or
 * null for any other key. These reads are saved only for recently opened tasks.
 */
export function taskChatFirstFrameRef(key: readonly unknown[]): string | null {
  const [root, kind, ref] = key;
  if (root !== "issues" || typeof ref !== "string" || !ref) return null;
  const rest = key.slice(3);
  const tail = (...values: string[]) => rest.length === values.length && values.every((value, index) => rest[index] === value);
  switch (kind) {
    case "comments": return tail("recent") ? ref : null;
    case "activity":
      if (tail("recent") || tail("comment-inputs", "batch-ids")) return ref;
      return rest.length === 3 && rest[0] === "comment-inputs" && rest[1] === "batch" && Array.isArray(rest[2]) ? ref : null;
    case "runs": return tail("recent-window") ? ref : null;
    case "documents": return tail("plan") ? ref : null;
    case "interactions": case "attachments": case "live-runs": case "active-run": case "work-products": return rest.length === 0 ? ref : null;
    default: return null;
  }
}

function boundedChatData(key: readonly unknown[], data: unknown): unknown {
  const recent = object(data);
  if (key[1] !== "comments" || !Array.isArray(recent?.comments) || recent.comments.length <= SAVED_TASK_CHAT_MAX_COMMENTS) return data;
  // The window is chronological; keep its newest comments and say more exist.
  const comments = recent.comments.slice(-SAVED_TASK_CHAT_MAX_COMMENTS);
  return { ...recent, comments, hasMore: true, oldestCommentId: object(comments[0])?.id ?? null };
}

/** Task ref (lowercase) → company, from saved or cached task records. */
function taskCompaniesOf(queries: Iterable<{ queryKey: readonly unknown[]; state: { data: unknown } }>, keep?: (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => boolean) {
  const companies = new Map<string, string>();
  for (const query of queries) {
    if (!Array.isArray(query?.queryKey) || query.queryKey[0] !== "issues" || query.queryKey[1] !== "detail") continue;
    const companyId = object(query.state?.data)?.companyId;
    if (typeof companyId !== "string" || (keep && !keep(query))) continue;
    for (const ref of issueRefs(query)) companies.set(ref, companyId);
  }
  return companies;
}

function browserStorage(): CacheStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

// Native Storage can change enumeration order after a deletion.
const storageKeys = (storage: CacheStorage) => Array.from({ length: storage.length }, (_, i) => storage.key(i))
  .filter((key): key is string => key !== null);

function removeRecords(storage: CacheStorage) {
  for (const key of storageKeys(storage)) {
    if (key.startsWith(QUERY_CACHE_PREFIX)) storage.removeItem(key);
  }
}

function removeUserRecords(storage: CacheStorage, userId: string, keepRevision?: string | null) {
  const prefix = `${QUERY_CACHE_PREFIX}${encodeURIComponent(userId)}:`;
  for (const key of storageKeys(storage)) {
    if (!key.startsWith(prefix)) continue;
    if (keepRevision !== undefined) {
      try { if ((JSON.parse(storage.getItem(key) ?? "null")?.revision ?? null) === keepRevision) continue; } catch {}
    }
    storage.removeItem(key);
  }
  if (storage.getItem(QUERY_CACHE_ACTIVE) === userId && !storage.getItem(recordKey(userId, null))) storage.removeItem(QUERY_CACHE_ACTIVE);
}

/**
 * True while `key` holds only what this document restored from the saved read
 * cache: no read in this document has answered it yet. Such data is shown at
 * once, but its next read is a revalidation that may share a page bootstrap
 * instead of always asking the server.
 */
export function isRestoredSavedRead(client: QueryClient, key: readonly unknown[]) {
  const state = client.getQueryState(key);
  if (state?.data === undefined) return false;
  return restoredReads.get(client)?.get(hashKey(key)) === state.dataUpdatedAt;
}

export function clearPersistedQueryCache(client: QueryClient) {
  controllers.get(client)?.clear();
}

function companyIdsFor(client: QueryClient, userId: string): string[] {
  const result = client.getQueryData<{ companies?: Array<{ id: string }> }>(queryKeys.companies.list(userId));
  return (result?.companies ?? []).map(company => company.id).filter(id => typeof id === "string" && id.length > 0);
}

export function persistedQueryScope(key: readonly unknown[], data: unknown, userId: string, companyIds: readonly string[], taskCompanies?: ReadonlyMap<string, string>): string | null | undefined {
  const [root, second, third] = key;
  const chatRef = taskChatFirstFrameRef(key);
  if (chatRef !== null) {
    // A chat read belongs to the company of a saved (recent) task record.
    const companyId = taskCompanies?.get(chatRef.toLowerCase());
    return companyId && companyIds.includes(companyId) ? companyId : undefined;
  }
  if (hashKey(key) === hashKey(queryKeys.auth.session)) return userIdOf(data) === userId ? null : undefined;
  if (key.length === 1 && root === "health") return null;
  if (root === "companies" && second === "list" && third === userId && key.length === 3) return null;
  if (root === "access" && second === "current-board-access" && third === userId && key.length === 3 && object(data)?.userId === userId) return null;
  if (root === "instance" && key.length === 2 && ["experimental-settings", "general-settings"].includes(String(second))) return null;
  if (root === "workspace-preferences" && second === userId && key.length === 2 && object(data)?.userId === userId) return null;
  if (root === "sidebar-preferences" && second === "company-order" && third === userId && key.length === 3) return null;
  if (root === "plugins" && second === "ui-contributions" && key.length === 2) return null;
  if (root === "issues" && second === "detail" && (key.length === 3 || (key.length === 4 && key[3] === "core"))) {
    const companyId = object(data)?.companyId;
    return typeof companyId === "string" && companyIds.includes(companyId) ? companyId : undefined;
  }
  if (typeof second !== "string" || !companyIds.includes(second)) return undefined;
  if (root === "link-preview" && typeof key[3] === "string"
    && hashKey(key) === hashKey(queryKeys.linkPreview(second, userId, key[3]))) return second;
  if (isLegacyInboxQuery(key) && Array.isArray(data)) return second;
  if (["sidebar-badges", "agents", "built-in-agents"].includes(String(root)) && key.length === 2) return second;
  if (root === "projects" && key.length <= 3) return second;
  if (root === "agent-chats" && key.length === 3 && third === userId) return second;
  if (root === "primary-agent" && third === userId && key.length === 3) return second;
  if (root === "issues" && third === "mine-context" && key.length === 4 && key[3] === userId && object(data)?.userId === userId) return second;
  if (root === "inbox" && third === "mine-reveal-sources" && key.length === 4 && key[3] === userId
    && object(data)?.userId === userId && object(data)?.companyId === second) return second;
  if (root === "issues" && ["mine-by-me", "touched-by-me"].includes(String(third))
    && key[3] === "index" && key[4] === "with-routine-executions" && key[5] === "live-descendant-summary"
    && key[6] === 100 && (third === "mine-by-me" ? key.length === 8 && key[7] === userId : key.length === 7)) return second;
  return undefined;
}

function clearAccountData(client: QueryClient) {
  detachInflightGets();
  const keep = (query: Query) => hashKey(query.queryKey) === hashKey(queryKeys.health) || hashKey(query.queryKey) === hashKey(queryKeys.auth.session);
  // Silent: the state written below is final. A non-silent cancel settles
  // later as a query error and would replace it with `CancelledError`.
  void client.cancelQueries({ predicate: query => !keep(query) }, { revert: false, silent: true });
  for (const query of client.getQueryCache().getAll()) {
    if (keep(query)) continue;
    query.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: "pending", fetchStatus: "idle", dataUpdateCount: 0 });
    client.getQueryCache().remove(query);
  }
}

export function startPersistedQueryCache(client: QueryClient, options: {
  buildId: string | null;
  storage?: CacheStorage | null;
  now?: () => number;
  eventTarget?: Window | null;
  debounceMs?: number;
}): { flush: () => void; clear: () => void; dispose: () => void } {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const buildId = options.buildId;
  const now = options.now ?? Date.now;
  const target = options.eventTarget === undefined ? (typeof window === "undefined" ? null : window) : options.eventTarget;
  let owner: string | null = null;
  let ownerRevision: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;
  let disposed = false;
  let sessionEpoch = 0;
  const sessionReads = new WeakMap<Query, { epoch: number; clear: string | null; userId: string | null; revisions: Map<string, string | null> }>();
  const visits = new Map<string, number>();
  const deniedIssues = new Set<string>();
  const blockedQueries = new Set<string>();
  const clearToken = () => { try { return storage?.getItem(QUERY_CACHE_CLEARED) ?? null; } catch { return null; } };
  let observedClear = clearToken();
  const revisionKey = (userId: string) => `${REVISION_PREFIX}${encodeURIComponent(userId)}`;
  const revisionFor = (userId: string) => { try { return storage?.getItem(revisionKey(userId)) ?? null; } catch { return null; } };
  const captureSessionRead = (query: Query) => {
    const userId = owner ?? userIdOf(query.state.data);
    const revisions = new Map<string, string | null>();
    try {
      if (storage) for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key?.startsWith(REVISION_PREFIX)) revisions.set(key, storage.getItem(key));
      }
    } catch {}
    sessionReads.set(query, { epoch: sessionEpoch, clear: clearToken(), userId, revisions });
  };
  const safeRemove = () => { try { if (storage) removeRecords(storage); } catch {} };
  const removeUser = (userId: string | null, preserveCurrent = false) => {
    try { if (storage && userId) removeUserRecords(storage, userId, preserveCurrent ? revisionFor(userId) : undefined); } catch {}
  };
  const cancelTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const clear = () => {
    detachInflightGets();
    sessionEpoch += 1;
    cancelTimer();
    const previous = owner ?? userIdOf(client.getQueryData(queryKeys.auth.session));
    const token = createUuid();
    const publish = () => {
      if (previous) storage?.setItem(revisionKey(previous), token);
      observedClear = JSON.stringify({ token, userId: previous });
      storage?.setItem(QUERY_CACHE_CLEARED, observedClear);
    };
    try { publish(); }
    catch {
      if (previous) removeUser(previous);
      else safeRemove();
      try { publish(); } catch {}
    }
    if (previous) removeUser(previous, revisionFor(previous) === token);
    else safeRemove();
    suspended = true;
    owner = null;
    ownerRevision = null;
    verifyCachedSession(client);
  };
  // Unstamped bundles do not hydrate or save reads, but sign-out still uses
  // the same revocation and cleanup path as a stamped bundle.
  if (!buildId?.trim()) {
    controllers.set(client, { clear });
    return { flush: () => {}, clear, dispose: () => { controllers.delete(client); } };
  }
  const suspendAccount = () => {
    sessionEpoch += 1;
    removeUser(owner, true);
    suspended = true;
    cancelTimer();
    owner = null;
    ownerRevision = null;
    verifyCachedSession(client);
    clearAccountData(client);
    client.setQueryData(queryKeys.auth.session, null);
    void client.refetchQueries({ queryKey: queryKeys.auth.session, type: "active" });
  };
  const observeStorage = () => {
    const token = clearToken();
    if (token !== observedClear) {
      observedClear = token;
      let clearedUser: string | null = null;
      try { const id = object(JSON.parse(token ?? "null"))?.userId; clearedUser = typeof id === "string" ? id : null; } catch {}
      removeUser(clearedUser, true);
      if (!clearedUser) { removeUser(owner); suspendAccount(); return true; }
      if (clearedUser === owner && ownerRevision !== revisionFor(clearedUser)) { suspendAccount(); return true; }
    }
    try {
      const active = storage?.getItem(QUERY_CACHE_ACTIVE);
      if (owner && active && active !== owner) { suspendAccount(); return true; }
    } catch {}
    return false;
  };

  const read = (userId: string, companyId: string | null): Envelope | null => {
    if (!storage) return null;
    try {
      const key = recordKey(userId, companyId);
      const raw = storage.getItem(key);
      if (!raw) return null;
      const entry = JSON.parse(raw) as Envelope;
      if (raw.length > MAX_RECORD_BYTES || entry.version !== 1 || entry.userId !== userId || entry.companyId !== companyId
        || entry.buildId !== buildId || (entry.revision ?? null) !== revisionFor(userId) || !Number.isFinite(entry.savedAt) || now() - entry.savedAt < 0
        || now() - entry.savedAt > QUERY_CACHE_MAX_AGE || !Array.isArray(entry.state?.queries)) {
        storage.removeItem(key);
        return null;
      }
      return entry;
    } catch { return null; }
  };
  const fresh = (updatedAt: number) => Number.isFinite(updatedAt) && now() - updatedAt >= 0 && now() - updatedAt <= QUERY_CACHE_MAX_AGE;
  const savedQueries = (entry: Envelope, companyIds: string[]) => {
    const taskCompanies = taskCompaniesOf(entry.state.queries);
    return entry.state.queries.filter(query => query?.state?.data !== undefined && query.state.status === "success"
      && fresh(query.state.dataUpdatedAt) && Array.isArray(query.queryKey) && !blockedQueries.has(hashKey(query.queryKey))
      && persistedQueryScope(query.queryKey, query.state.data, entry.userId, companyIds, taskCompanies) === entry.companyId);
  };
  const readSaved = (userId: string): Envelope[] => {
    if (!storage) return [];
    const prefix = `${QUERY_CACHE_PREFIX}${encodeURIComponent(userId)}:`;
    try {
      return storageKeys(storage).flatMap(key => {
        if (!key.startsWith(prefix)) return [];
        try {
          const suffix = key.slice(prefix.length);
          const entry = read(userId, suffix === "root" ? null : decodeURIComponent(suffix));
          return entry ? [entry] : [];
        } catch { return []; }
      });
    } catch { return []; }
  };
  const approvedCompanies = (userId: string, entries: Envelope[]) => {
    const key = queryKeys.companies.list(userId);
    const live = client.getQueryState(key);
    if (blockedQueries.has(hashKey(key)) || (live?.status === "error" && !isTransientError(live.error))) return [];
    const saved = entries.find(entry => entry.companyId === null);
    const cached = saved && savedQueries(saved, []).find(query => hashKey(query.queryKey) === hashKey(key));
    const data = live?.data === undefined ? cached?.state.data : live.data;
    const companies = object(data)?.companies;
    return Array.isArray(companies) ? companies.flatMap(company => {
      const id = object(company)?.id;
      return typeof id === "string" && id ? [id] : [];
    }) : [];
  };
  type SavedQuery = DehydratedState["queries"][number];
  const projectQuery = (query: SavedQuery, userId: string): SavedQuery => {
    let data = queryDisplayData(query.queryKey, query.state.data, deniedIssues);
    if (hashKey(query.queryKey) === hashKey(queryKeys.auth.session)) {
      const user = object(object(data)?.user)!;
      data = { session: { userId }, user: { id: userId, name: user.name, email: user.email, image: user.image }, sentryDsn: null };
    } else if (Array.isArray(object(data)?.pages)) {
      const value = object(data)!;
      data = { ...value, pages: (value.pages as unknown[]).slice(0, 1), pageParams: (value.pageParams as unknown[] | undefined)?.slice(0, 1) };
    }
    return { queryKey: query.queryKey, queryHash: hashKey(query.queryKey), state: { ...query.state, data, error: null, status: "success", fetchStatus: "idle", fetchFailureReason: null, fetchMeta: null } };
  };
  const allowedIssue = (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => {
    const chatRef = taskChatFirstFrameRef(query.queryKey);
    if (chatRef !== null) return !deniedIssues.has(chatRef.toLowerCase());
    return !(query.queryKey[0] === "issues" && query.queryKey[1] === "detail" && issueRefs(query).some(id => deniedIssues.has(id)));
  };
  const scrubSaved = (userId: string, entries: Envelope[]) => {
    if (!storage || ownerRevision !== revisionFor(userId)) return;
    const companies = approvedCompanies(userId, entries);
    for (const entry of entries) {
      if (ownerRevision !== revisionFor(userId)) return;
      const key = recordKey(userId, entry.companyId);
      const queries = savedQueries(entry, companies).filter(allowedIssue).map(query => projectQuery(query, userId)).filter(query => query.state.data !== undefined);
      try { storage.setItem(key, JSON.stringify({ ...entry, state: { mutations: [], queries } })); }
      catch { try { storage.removeItem(key); } catch {} }
    }
  };
  const restoreState = (entry: Envelope, companyIds: string[]) => {
    const queries = savedQueries(entry, companyIds).filter(allowedIssue)
      .map(query => ({ queryKey: query.queryKey, queryHash: hashKey(query.queryKey), state: {
        data: queryDisplayData(query.queryKey, query.state.data, deniedIssues), dataUpdatedAt: query.state.dataUpdatedAt, dataUpdateCount: 1,
        error: null, errorUpdateCount: 0, errorUpdatedAt: 0, fetchFailureCount: 0, fetchFailureReason: null,
        // Optional link enrichment stays demand-driven. Keep its original read
        // time so a fresh hover reuses it and a stale hover refreshes it.
        fetchMeta: null, isInvalidated: query.queryKey[0] !== "link-preview", status: "success" as const, fetchStatus: "idle" as const,
      } }));
    hydrate(client, { mutations: [], queries });
    let restored = restoredReads.get(client);
    if (!restored) restoredReads.set(client, restored = new Map());
    for (const query of queries) restored.set(query.queryHash, query.state.dataUpdatedAt);
  };
  try {
    const current = client.getQueryState(queryKeys.auth.session);
    const active = current?.status === "success" ? userIdOf(current.data) : storage?.getItem(QUERY_CACHE_ACTIVE);
    const entry = active ? read(active, null) : null;
    if (!entry) safeRemove();
    const cachedSession = entry?.state.queries.find(query => hashKey(query.queryKey) === hashKey(queryKeys.auth.session));
    if (entry && cachedSession?.state.status === "success" && fresh(cachedSession.state.dataUpdatedAt) && userIdOf(cachedSession.state.data) === active) {
      owner = active!;
      ownerRevision = entry.revision ?? null;
      if (current?.data === undefined) markCachedSession(client);
      restoreState(entry, []);
      const companyIds = companyIdsFor(client, owner);
      for (const companyId of companyIds) {
        const company = read(owner, companyId);
        if (company) restoreState(company, companyIds);
      }
    } else if (entry) safeRemove();
  } catch {}
  const pendingSession = client.getQueryCache().find({ queryKey: queryKeys.auth.session, exact: true });
  if (pendingSession && pendingSession.state.fetchStatus !== "idle") captureSessionRead(pendingSession);

  const flush = () => {
    cancelTimer();
    if (observeStorage()) return;
    if (!storage || disposed || suspended || hasUnverifiedSession(client)) return;
    const session = client.getQueryData(queryKeys.auth.session);
    const userId = userIdOf(session);
    if (!userId) return;
    if (owner !== userId) { owner = userId; ownerRevision = revisionFor(userId); }
    if (ownerRevision !== revisionFor(userId)) { suspendAccount(); return; }
    const entries = readSaved(userId);
    const companies = approvedCompanies(userId, entries);
    const knownTasks = taskCompaniesOf([...client.getQueryCache().getAll(), ...entries.flatMap(entry => entry.state.queries)]);
    const eligible = (query: Query) => query.state.data !== undefined
      && (query.state.status === "success" || isTransientError(query.state.error))
      && !blockedQueries.has(hashKey(query.queryKey))
      && fresh(query.state.dataUpdatedAt)
      && persistedQueryScope(query.queryKey, query.state.data, userId, companies, knownTasks) !== undefined;
    // Memory GC is independent of the on-disk lifetime. Retain valid saved
    // reads, prefer newer data, and apply the same limits to the merged set.
    const merged = new Map<string, SavedQuery>();
    for (const entry of entries) for (const query of savedQueries(entry, companies)) merged.set(hashKey(query.queryKey), query);
    for (const query of client.getQueryCache().getAll()) {
      if (query.state.status === "error" && !isTransientError(query.state.error)) merged.delete(hashKey(query.queryKey));
    }
    const state = dehydrate(client, { shouldDehydrateMutation: () => false, shouldDehydrateQuery: eligible });
    for (const query of state.queries) {
      const key = hashKey(query.queryKey);
      if (!merged.has(key) || merged.get(key)!.state.dataUpdatedAt <= query.state.dataUpdatedAt) merged.set(key, query);
    }
    const recent = [...merged.values()].filter(query => query.queryKey[0] === "issues" && query.queryKey[1] === "detail" && allowedIssue(query))
      .sort((a, b) => (visits.get(hashKey(b.queryKey)) ?? b.state.dataUpdatedAt) - (visits.get(hashKey(a.queryKey)) ?? a.state.dataUpdatedAt));
    const issueIds = new Set<string>();
    for (const query of recent) if (issueIds.size < QUERY_CACHE_MAX_ISSUES) issueIds.add(issueIdentity(query));
    const previews = new Set([...merged.values()].filter(query => query.queryKey[0] === "link-preview")
      .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt).slice(0, MAX_LINK_PREVIEWS).map(query => hashKey(query.queryKey)));
    // Saved chat reads follow their task: only the recent tasks kept above,
    // newest first, within the per-task and total byte budgets.
    const keptTasks = recent.filter(query => issueIds.has(issueIdentity(query)));
    const taskCompanies = taskCompaniesOf(keptTasks);
    const taskIdentity = new Map<string, string>();
    for (const query of keptTasks) for (const ref of issueRefs(query)) taskIdentity.set(ref, issueIdentity(query));
    const projected = [...merged.values()].filter(query => allowedIssue(query)
      && (query.queryKey[0] !== "link-preview" || previews.has(hashKey(query.queryKey)))
      && !(query.queryKey[0] === "issues" && query.queryKey[1] === "detail" && !issueIds.has(issueIdentity(query))))
      .map(query => projectQuery(query, userId)).filter(query => query.state.data !== undefined);
    const chatTaskOf = (query: SavedQuery) => {
      const ref = taskChatFirstFrameRef(query.queryKey);
      return ref === null ? null : taskIdentity.get(ref.toLowerCase()) ?? "";
    };
    const chatBytes = new Map<string, number>();
    for (const query of projected) {
      const task = chatTaskOf(query);
      if (task) chatBytes.set(task, (chatBytes.get(task) ?? 0) + JSON.stringify(query).length);
    }
    const savedChatTasks = new Set<string>();
    let chatTotal = 0;
    for (const task of issueIds) {
      const bytes = chatBytes.get(task);
      if (bytes === undefined || bytes > SAVED_TASK_CHAT_MAX_TASK_BYTES || chatTotal + bytes > SAVED_TASK_CHAT_MAX_BYTES) continue;
      chatTotal += bytes;
      savedChatTasks.add(task);
    }
    const queries = projected.filter(query => {
      const task = chatTaskOf(query);
      return task === null || savedChatTasks.has(task);
    });
    try {
      const expected = new Set([QUERY_CACHE_ACTIVE]);
      for (const companyId of [null, ...companies]) {
        const key = recordKey(userId, companyId);
        expected.add(key);
        const scoped = queries.filter(query => persistedQueryScope(query.queryKey, query.state.data, userId, companies, taskCompanies) === companyId);
        const write = (records: SavedQuery[]) => {
          const serialized = JSON.stringify({ version: 1, userId, companyId, buildId, revision: ownerRevision, savedAt: now(),
            state: { mutations: [], queries: records } } satisfies Envelope);
          if (serialized.length > MAX_RECORD_BYTES) return false;
          try { storage.setItem(key, serialized); return true; } catch { return false; }
        };
        // Saved chat is optional: when it does not fit, keep the rest of the record.
        if (!write(scoped) && !write(scoped.filter(query => taskChatFirstFrameRef(query.queryKey) === null))) storage.removeItem(key);
      }
      const userPrefix = `${QUERY_CACHE_PREFIX}${encodeURIComponent(userId)}:`;
      for (const key of storageKeys(storage)) {
        if (key.startsWith(userPrefix) && !expected.has(key)) storage.removeItem(key);
      }
      const active = storage.getItem(QUERY_CACHE_ACTIVE);
      if (ownerRevision !== revisionFor(userId) || (active && active !== userId)) { suspendAccount(); return; }
      if (active !== userId) storage.setItem(QUERY_CACHE_ACTIVE, userId);
    } catch {}
  };
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (disposed) return;
    // Any answer or local write replaces what was restored.
    if (event.type === "updated" && event.action.type === "success") restoredReads.get(client)?.delete(event.query.queryHash);
    const sessionEvent = hashKey(event.query.queryKey) === hashKey(queryKeys.auth.session);
    const completedRead = sessionEvent && event.type === "updated" && event.action.type === "success" && !event.action.manual
      ? sessionReads.get(event.query) : undefined;
    if (sessionEvent && event.type === "updated" && event.action.type === "fetch") captureSessionRead(event.query);
    if (sessionEvent && event.type === "updated" && event.action.type === "success" && !event.action.manual) {
      const read = completedRead;
      sessionReads.delete(event.query);
      // A delayed response cannot verify identity across sign-out, including
      // before another tab's storage event has reached this event loop.
      if (observeStorage()) return;
      let clearedUser: string | null = null;
      try { const id = object(JSON.parse(clearToken() ?? "null"))?.userId; clearedUser = typeof id === "string" ? id : null; } catch {}
      const next = userIdOf(event.query.state.data);
      if (read && (read.epoch !== sessionEpoch
        || [read.userId, next].some(id => id && (read.revisions.get(revisionKey(id)) ?? null) !== revisionFor(id))
        || (read.clear !== clearToken() && (!clearedUser || clearedUser === read.userId || clearedUser === userIdOf(event.query.state.data))))) {
        suspendAccount(); return;
      }
    }
    if (sessionEvent && event.type === "updated" && event.action.type === "error"
      && ["auth", "forbidden"].includes(classifyError(event.action.error))) {
      clearAccountData(client);
      clear();
      client.setQueryData(queryKeys.auth.session, null);
      return;
    }
    if (suspended) {
      if (!sessionEvent || event.type !== "updated" || event.action.type !== "success" || event.action.manual || !userIdOf(event.query.state.data)) return;
      suspended = false;
    }
    if (sessionEvent && event.type === "updated" && event.action.type === "success") {
      if (!event.action.manual) { observedClear = completedRead ? completedRead.clear : clearToken(); verifyCachedSession(client); }
      const next = userIdOf(event.query.state.data);
      if (owner && next !== owner) {
        if (next) removeUser(owner);
        clearAccountData(client);
      }
      if (!next) { clear(); return; }
      if (next && (!event.action.manual || next !== owner)) ownerRevision = completedRead
        ? completedRead.revisions.get(revisionKey(next)) ?? null : revisionFor(next);
      owner = next;
    }
    if (event.type === "observerAdded" && event.query.queryKey[0] === "issues" && event.query.queryKey[1] === "detail") visits.set(event.query.queryHash, now());
    const issueDetail = event.query.queryKey[0] === "issues" && event.query.queryKey[1] === "detail";
    const chatRef = taskChatFirstFrameRef(event.query.queryKey);
    if (event.type === "updated" && event.action.type === "success" && !event.action.manual) {
      blockedQueries.delete(hashKey(event.query.queryKey));
      if (issueDetail) for (const id of issueRefs(event.query)) deniedIssues.delete(id);
    }
    if (event.type === "updated" && event.action.type === "error" && !isTransientError(event.action.error)) {
      blockedQueries.add(hashKey(event.query.queryKey));
      const userId = owner ?? userIdOf(client.getQueryData(queryKeys.auth.session));
      const saved = userId ? readSaved(userId) : [];
      const refusal = classifyError(event.action.error);
      const revokesTask = issueDetail
        ? ["auth", "forbidden", "not_found"].includes(refusal)
        : chatRef !== null && (["auth", "forbidden"].includes(refusal) || (refusal === "not_found" && event.query.queryKey[1] === "comments"));
      if (revokesTask) {
        // A refused task read, or a refused read of its saved chat, removes the
        // task and its saved chat at once, from memory and from storage.
        const ids = new Set(issueDetail ? issueRefs(event.query) : [chatRef!.toLowerCase()]);
        const matches = (query: Query) => {
          const ref = taskChatFirstFrameRef(query.queryKey);
          if (ref !== null) return ids.has(ref.toLowerCase());
          return query.queryKey[0] === "issues" && query.queryKey[1] === "detail" && issueRefs(query).some(id => ids.has(id));
        };
        for (const query of [...client.getQueryCache().getAll(), ...saved.flatMap(entry => entry.state.queries)].filter(query => Array.isArray(query?.queryKey) && query.queryKey[0] === "issues" && query.queryKey[1] === "detail" && issueRefs(query).some(id => ids.has(id)))) {
          for (const id of issueRefs(query)) ids.add(id);
        }
        for (const id of ids) deniedIssues.add(id);
        // Chat keys of the task's other refs (an id when it was read by identifier).
        for (const query of client.getQueryCache().getAll()) {
          const ref = taskChatFirstFrameRef(query.queryKey);
          if (ref !== null && ids.has(ref.toLowerCase())) deniedIssues.add(ref.toLowerCase());
        }
        void client.cancelQueries({ predicate: matches }, { revert: false, silent: true });
        for (const query of client.getQueryCache().getAll().filter(matches)) query.setState({ data: undefined, dataUpdatedAt: 0,
          error: event.action.error, status: "error", fetchStatus: "idle" });
      }
      if (userId) scrubSaved(userId, saved);
      flush(); return;
    }
    cancelTimer();
    timer = setTimeout(flush, options.debounceMs ?? 250);
  });
  const onStorage = (event: StorageEvent) => {
    if (owner && event.key === revisionKey(owner) && event.newValue !== ownerRevision) { suspendAccount(); return; }
    if (event.key !== QUERY_CACHE_CLEARED && !(event.key === QUERY_CACHE_ACTIVE && event.newValue !== owner)) return;
    if (event.key === QUERY_CACHE_CLEARED && event.newValue !== clearToken()) return;
    if (event.key === QUERY_CACHE_CLEARED) {
      try { const id = object(JSON.parse(event.newValue ?? "null"))?.userId; if (typeof id === "string") removeUser(id, true); } catch {}
    }
    observeStorage();
  };
  const onPageHide = () => flush();
  target?.addEventListener("storage", onStorage);
  target?.addEventListener("pagehide", onPageHide);
  const dispose = () => {
    disposed = true;
    cancelTimer();
    unsubscribe();
    target?.removeEventListener("storage", onStorage);
    target?.removeEventListener("pagehide", onPageHide);
    controllers.delete(client);
  };
  controllers.set(client, { clear });
  return { flush, clear, dispose };
}
