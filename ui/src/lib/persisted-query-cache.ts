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
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const REVISION_PREFIX = "paperclip:query-cache-revision:";
const controllers = new WeakMap<QueryClient, { clear: () => void }>();
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
function displayData(value: unknown, denied: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(item => displayData(item, denied)).filter(item => item !== undefined);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const row = value as Record<string, unknown>;
  if (typeof row.id === "string" && denied.has(row.id.toLowerCase())) return undefined;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !excludedFields.has(key.toLowerCase()))
    .map(([key, item]) => {
      if (key === "runtimeConfig") return [key, {}];
      if (key === "adapterConfig") {
        const config = object(item);
        return [key, Object.fromEntries(["provider", "model", "agent", "acpxAgent", "effort", "modelReasoningEffort", "reasoningEffort", "thinking", "variant"]
          .filter(field => typeof config?.[field] === "string").map(field => [field, config![field]]).concat(typeof config?.fastMode === "boolean" ? [["fastMode", config.fastMode]] : []))];
      }
      return [key, displayData(item, denied)];
    }));
}

function isLegacyInboxQuery(key: readonly unknown[]): boolean {
  const suffix = key[2] === "mine-by-me" || key[2] === "touched-by-me" ? key.slice(3) : key.slice(2);
  return key[0] === "issues" && suffix.length === 4 && suffix[0] === "compact"
    && suffix[1] === "with-routine-executions" && suffix[2] === "live-descendant-summary" && suffix[3] === 500;
}

function queryDisplayData(key: readonly unknown[], data: unknown, denied: ReadonlySet<string>): unknown {
  return displayData(isLegacyInboxQuery(key) && Array.isArray(data) ? data.slice(0, 100) : data, denied);
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

export function clearPersistedQueryCache(client: QueryClient) {
  controllers.get(client)?.clear();
}

function companyIdsFor(client: QueryClient, userId: string): string[] {
  const result = client.getQueryData<{ companies?: Array<{ id: string }> }>(queryKeys.companies.list(userId));
  return (result?.companies ?? []).map(company => company.id).filter(id => typeof id === "string" && id.length > 0);
}

export function persistedQueryScope(key: readonly unknown[], data: unknown, userId: string, companyIds: readonly string[]): string | null | undefined {
  const [root, second, third] = key;
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
  if (isLegacyInboxQuery(key) && Array.isArray(data)) return second;
  if (["sidebar-badges", "agents", "built-in-agents"].includes(String(root)) && key.length === 2) return second;
  if (root === "projects" && key.length <= 3) return second;
  if (root === "agent-chats" && key.length === 3 && third === userId) return second;
  if (root === "primary-agent" && third === userId && key.length === 3) return second;
  if (root === "issues" && third === "mine-context" && key.length === 4 && key[3] === userId && object(data)?.userId === userId) return second;
  if (root === "issues" && ["mine-by-me", "touched-by-me"].includes(String(third))
    && key[3] === "index" && key[4] === "with-routine-executions" && key[5] === "live-descendant-summary"
    && key[6] === 100 && (third === "mine-by-me" ? key.length === 8 && key[7] === userId : key.length === 7)) return second;
  return undefined;
}

function clearAccountData(client: QueryClient) {
  detachInflightGets();
  const keep = (query: Query) => hashKey(query.queryKey) === hashKey(queryKeys.health) || hashKey(query.queryKey) === hashKey(queryKeys.auth.session);
  void client.cancelQueries({ predicate: query => !keep(query) }, { revert: false });
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
  const savedQueries = (entry: Envelope, companyIds: string[]) => entry.state.queries.filter(query => query?.state?.data !== undefined && query.state.status === "success"
    && fresh(query.state.dataUpdatedAt) && Array.isArray(query.queryKey) && !blockedQueries.has(hashKey(query.queryKey))
    && persistedQueryScope(query.queryKey, query.state.data, entry.userId, companyIds) === entry.companyId);
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
  const allowedIssue = (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => !(query.queryKey[0] === "issues" && query.queryKey[1] === "detail"
    && issueRefs(query).some(id => deniedIssues.has(id)));
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
    const queries = savedQueries(entry, companyIds)
      .map(query => ({ queryKey: query.queryKey, queryHash: hashKey(query.queryKey), state: {
        data: queryDisplayData(query.queryKey, query.state.data, deniedIssues), dataUpdatedAt: query.state.dataUpdatedAt, dataUpdateCount: 1,
        error: null, errorUpdateCount: 0, errorUpdatedAt: 0, fetchFailureCount: 0, fetchFailureReason: null,
        fetchMeta: null, isInvalidated: true, status: "success" as const, fetchStatus: "idle" as const,
      } }));
    hydrate(client, { mutations: [], queries });
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
    const eligible = (query: Query) => query.state.data !== undefined
      && (query.state.status === "success" || isTransientError(query.state.error))
      && !blockedQueries.has(hashKey(query.queryKey))
      && fresh(query.state.dataUpdatedAt)
      && persistedQueryScope(query.queryKey, query.state.data, userId, companies) !== undefined;
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
    const queries = [...merged.values()].filter(query => allowedIssue(query)
      && !(query.queryKey[0] === "issues" && query.queryKey[1] === "detail" && !issueIds.has(issueIdentity(query))))
      .map(query => projectQuery(query, userId)).filter(query => query.state.data !== undefined);
    try {
      const expected = new Set([QUERY_CACHE_ACTIVE]);
      for (const companyId of [null, ...companies]) {
        const key = recordKey(userId, companyId);
        expected.add(key);
        const envelope: Envelope = { version: 1, userId, companyId, buildId, revision: ownerRevision, savedAt: now(),
          state: { mutations: [], queries: queries.filter(query => persistedQueryScope(query.queryKey, query.state.data, userId, companies) === companyId) } };
        const serialized = JSON.stringify(envelope);
        if (serialized.length <= MAX_RECORD_BYTES) storage.setItem(key, serialized);
        else storage.removeItem(key);
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
    if (event.type === "updated" && event.action.type === "success" && !event.action.manual) {
      blockedQueries.delete(hashKey(event.query.queryKey));
      if (issueDetail) for (const id of issueRefs(event.query)) deniedIssues.delete(id);
    }
    if (event.type === "updated" && event.action.type === "error" && !isTransientError(event.action.error)) {
      blockedQueries.add(hashKey(event.query.queryKey));
      const userId = owner ?? userIdOf(client.getQueryData(queryKeys.auth.session));
      const saved = userId ? readSaved(userId) : [];
      if (issueDetail && ["auth", "forbidden", "not_found"].includes(classifyError(event.action.error))) {
        const ids = new Set(issueRefs(event.query));
        const matches = (query: Query) => query.queryKey[0] === "issues" && query.queryKey[1] === "detail"
          && issueRefs(query).some(id => ids.has(id));
        for (const query of [...client.getQueryCache().getAll(), ...saved.flatMap(entry => entry.state.queries)].filter(query => Array.isArray(query?.queryKey) && query.queryKey[0] === "issues" && query.queryKey[1] === "detail" && issueRefs(query).some(id => ids.has(id)))) {
          for (const id of issueRefs(query)) ids.add(id);
        }
        for (const id of ids) deniedIssues.add(id);
        void client.cancelQueries({ predicate: matches }, { revert: false });
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
