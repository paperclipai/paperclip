import { dehydrate, hashKey, hydrate, type DehydratedState, type Query, type QueryClient } from "@tanstack/react-query";
import { classifyError, isTransientError } from "@/api/errors";
import { markCachedSession, verifyCachedSession, hasUnverifiedSession } from "./cached-session";
import { queryKeys } from "./queryKeys";

export const QUERY_CACHE_PREFIX = "paperclip:query-cache:v1:";
export const QUERY_CACHE_ACTIVE = `${QUERY_CACHE_PREFIX}active`;
export const QUERY_CACHE_CLEARED = "paperclip:query-cache-cleared";
export const QUERY_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
export const QUERY_CACHE_MAX_ISSUES = 20;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const controllers = new WeakMap<QueryClient, { clear: () => void }>();
type CacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
type Envelope = { version: 1; userId: string; companyId: string | null; buildId: string; savedAt: number; state: DehydratedState };
const object = (value: unknown): Record<string, unknown> | null => value != null && typeof value === "object" ? value as Record<string, unknown> : null;
const userIdOf = (value: unknown) => {
  const id = object(object(value)?.user)?.id;
  return typeof id === "string" && id ? id : null;
};
const recordKey = (userId: string, companyId: string | null) => `${QUERY_CACHE_PREFIX}${encodeURIComponent(userId)}:${companyId === null ? "root" : encodeURIComponent(companyId)}`;
const issueIdentity = (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => String(object(query.state.data)?.id ?? query.queryKey[2]);

function browserStorage(): CacheStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

function removeRecords(storage: CacheStorage) {
  for (let i = storage.length - 1; i >= 0; i -= 1) {
    const key = storage.key(i);
    if (key?.startsWith(QUERY_CACHE_PREFIX)) storage.removeItem(key);
  }
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
  const keep = (query: Query) => hashKey(query.queryKey) === hashKey(queryKeys.health) || hashKey(query.queryKey) === hashKey(queryKeys.auth.session);
  void client.cancelQueries({ predicate: query => !keep(query) }, { revert: false });
  for (const query of client.getQueryCache().getAll()) {
    if (keep(query)) continue;
    query.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: "pending", fetchStatus: "idle", dataUpdateCount: 0 });
    client.getQueryCache().remove(query);
  }
}

export function startPersistedQueryCache(client: QueryClient, options: {
  buildId: string;
  storage?: CacheStorage | null;
  now?: () => number;
  eventTarget?: Window | null;
  debounceMs?: number;
}): { flush: () => void; clear: () => void; dispose: () => void } {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const now = options.now ?? Date.now;
  const target = options.eventTarget === undefined ? (typeof window === "undefined" ? null : window) : options.eventTarget;
  let owner: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;
  let disposed = false;
  const visits = new Map<string, number>();
  const safeRemove = () => { try { if (storage) removeRecords(storage); } catch {} };
  const cancelTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const clear = () => {
    cancelTimer();
    safeRemove();
    suspended = true;
    owner = null;
    verifyCachedSession(client);
    try { storage?.setItem(QUERY_CACHE_CLEARED, crypto.randomUUID()); } catch {}
  };

  const read = (userId: string, companyId: string | null): Envelope | null => {
    if (!storage) return null;
    try {
      const key = recordKey(userId, companyId);
      const raw = storage.getItem(key);
      if (!raw) return null;
      const entry = JSON.parse(raw) as Envelope;
      if (raw.length > MAX_RECORD_BYTES || entry.version !== 1 || entry.userId !== userId || entry.companyId !== companyId
        || entry.buildId !== options.buildId || !Number.isFinite(entry.savedAt) || now() - entry.savedAt < 0
        || now() - entry.savedAt > QUERY_CACHE_MAX_AGE || !Array.isArray(entry.state?.queries)) {
        storage.removeItem(key);
        return null;
      }
      return entry;
    } catch { return null; }
  };
  const fresh = (updatedAt: number) => Number.isFinite(updatedAt) && now() - updatedAt >= 0 && now() - updatedAt <= QUERY_CACHE_MAX_AGE;
  const restoreState = (entry: Envelope, companyIds: string[]) => {
    const queries = entry.state.queries.filter(query => query.state?.data !== undefined && query.state.status === "success"
      && fresh(query.state.dataUpdatedAt) && Array.isArray(query.queryKey)
      && persistedQueryScope(query.queryKey, query.state.data, entry.userId, companyIds) === entry.companyId)
      .map(query => ({ queryKey: query.queryKey, queryHash: hashKey(query.queryKey), state: {
        data: query.state.data, dataUpdatedAt: query.state.dataUpdatedAt, dataUpdateCount: 1,
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
      if (current?.data === undefined) markCachedSession(client);
      restoreState(entry, []);
      const companyIds = companyIdsFor(client, owner);
      for (const companyId of companyIds) {
        const company = read(owner, companyId);
        if (company) restoreState(company, companyIds);
      }
    } else if (entry) safeRemove();
  } catch {}

  const flush = () => {
    cancelTimer();
    if (!storage || disposed || suspended || hasUnverifiedSession(client)) return;
    const session = client.getQueryData(queryKeys.auth.session);
    const userId = userIdOf(session);
    if (!userId) return;
    owner = userId;
    const companies = companyIdsFor(client, userId);
    const eligible = (query: Query) => query.state.data !== undefined
      && (query.state.status === "success" || isTransientError(query.state.error))
      && now() - query.state.dataUpdatedAt >= 0 && now() - query.state.dataUpdatedAt <= QUERY_CACHE_MAX_AGE
      && persistedQueryScope(query.queryKey, query.state.data, userId, companies) !== undefined;
    const recent = client.getQueryCache().getAll().filter(query => eligible(query) && query.queryKey[0] === "issues" && query.queryKey[1] === "detail")
      .sort((a, b) => (visits.get(b.queryHash) ?? b.state.dataUpdatedAt) - (visits.get(a.queryHash) ?? a.state.dataUpdatedAt));
    const issueIds = new Set<string>();
    for (const query of recent) if (issueIds.size < QUERY_CACHE_MAX_ISSUES) issueIds.add(issueIdentity(query));
    const state = dehydrate(client, { shouldDehydrateMutation: () => false, shouldDehydrateQuery: query => eligible(query)
      && !(query.queryKey[0] === "issues" && query.queryKey[1] === "detail" && !issueIds.has(issueIdentity(query))) });
    const queries = state.queries.map(query => {
      let data = query.state.data;
      if (hashKey(query.queryKey) === hashKey(queryKeys.auth.session)) {
        const value = object(data)!;
        const user = object(value.user)!;
        data = { session: { userId },
          user: { id: userId, name: user.name, email: user.email, image: user.image }, sentryDsn: null };
      } else if (Array.isArray(object(data)?.pages)) {
        const value = object(data)!;
        data = { ...value, pages: (value.pages as unknown[]).slice(0, 1), pageParams: (value.pageParams as unknown[] | undefined)?.slice(0, 1) };
      }
      return { queryKey: query.queryKey, queryHash: query.queryHash, state: { ...query.state, data, error: null, status: "success" as const, fetchStatus: "idle" as const, fetchFailureReason: null, fetchMeta: null } };
    });
    try {
      const expected = new Set([QUERY_CACHE_ACTIVE]);
      for (const companyId of [null, ...companies]) {
        const key = recordKey(userId, companyId);
        expected.add(key);
        const envelope: Envelope = { version: 1, userId, companyId, buildId: options.buildId, savedAt: now(),
          state: { mutations: [], queries: queries.filter(query => persistedQueryScope(query.queryKey, query.state.data, userId, companies) === companyId) } };
        const serialized = JSON.stringify(envelope);
        if (serialized.length <= MAX_RECORD_BYTES) storage.setItem(key, serialized);
        else storage.removeItem(key);
      }
      for (let i = storage.length - 1; i >= 0; i -= 1) {
        const key = storage.key(i);
        if (key?.startsWith(QUERY_CACHE_PREFIX) && !expected.has(key)) storage.removeItem(key);
      }
      storage.setItem(QUERY_CACHE_ACTIVE, userId);
    } catch {}
  };
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (disposed) return;
    const sessionEvent = hashKey(event.query.queryKey) === hashKey(queryKeys.auth.session);
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
      if (!event.action.manual) verifyCachedSession(client);
      const next = userIdOf(event.query.state.data);
      if (owner && next !== owner) {
        safeRemove();
        clearAccountData(client);
      }
      owner = next;
      if (!next) { clear(); return; }
    }
    if (event.type === "observerAdded" && event.query.queryKey[0] === "issues" && event.query.queryKey[1] === "detail") visits.set(event.query.queryHash, now());
    if (event.type === "updated" && event.action.type === "error" && !isTransientError(event.action.error)) { flush(); return; }
    cancelTimer();
    timer = setTimeout(flush, options.debounceMs ?? 250);
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key !== QUERY_CACHE_CLEARED && !(event.key === QUERY_CACHE_ACTIVE && event.newValue !== owner)) return;
    suspended = true;
    cancelTimer();
    owner = null;
    verifyCachedSession(client);
    clearAccountData(client);
    client.setQueryData(queryKeys.auth.session, null);
    void client.refetchQueries({ queryKey: queryKeys.auth.session, type: "active" });
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
