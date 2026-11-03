import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { bindAccount } from "./account-scope";
import { hasUnverifiedSession } from "./cached-session";
import { queryKeys } from "./queryKeys";
import { clearPersistedQueryCache, persistedQueryScope, QUERY_CACHE_ACTIVE, QUERY_CACHE_CLEARED, QUERY_CACHE_MAX_AGE, QUERY_CACHE_PREFIX, startPersistedQueryCache } from "./persisted-query-cache";

const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/api/auth", () => ({ authApi: auth }));

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const session = (id = "alice") => ({ session: { id: `session-${id}`, userId: id, token: "never-store-session-token" },
  user: { id, name: id, email: `${id}@example.test`, image: null }, sentryDsn: "never-store-dsn", boardBootstrap: { private: "not-allowlisted" } });
const handles: Array<() => void> = [];
function setup(storage = new MemoryStorage(), now?: () => number, client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), buildId = "build-one") {
  const handle = startPersistedQueryCache(client, { storage, now, buildId, eventTarget: null, debounceMs: 100_000 });
  handles.push(() => { handle.dispose(); client.clear(); });
  return { client, handle, storage };
}
function seed(client: QueryClient, userId = "alice", companyId = "company-one") {
  client.setQueryData(queryKeys.auth.session, session(userId));
  client.setQueryData(queryKeys.companies.list(userId), { companies: [{ id: companyId, name: "Example" }], unauthorized: false });
  client.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "authenticated" });
  client.setQueryData([...queryKeys.access.currentBoardAccess, userId], { userId, companyIds: [companyId], isInstanceAdmin: false });
  client.setQueryData([...queryKeys.issues.detail("task-one"), "core"], { id: "task-one", companyId, title: "Saved task" });
}
afterEach(() => { for (const dispose of handles.splice(0)) dispose(); vi.clearAllMocks(); });

describe("persisted read cache", () => {
  it("restores the approved shell and company reads without persisting authentication material", () => {
    const first = setup();
    seed(first.client);
    first.client.setQueryData(["secrets", "company-one"], { token: "not-allowed" });
    first.client.setQueryData(["issues", "browser", "task-one"], { url: "https://viewer.example.test/capability" });
    first.client.setQueryData(["issues", "documents", "task-one"], [{ body: "not-allowlisted" }]);
    const inboxKey = [...queryKeys.issues.listMineByMe("company-one"), "index", "with-routine-executions", "live-descendant-summary", 100, "alice"];
    first.client.setQueryData(inboxKey, [{ id: "inbox-task", title: "First page" }]);
    first.client.setQueryData(queryKeys.plugins.uiContributions, [{ pluginId: "example-plugin", displayName: "Example extension" }]);
    first.handle.flush();
    const disk = [...first.storage.values.values()].join(" ");
    expect(disk).not.toMatch(/never-store|not-allowed|not-allowlisted|viewer\.example/);
    const restored = setup(first.storage);
    expect(restored.client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toMatchObject({ title: "Saved task" });
    expect(restored.client.getQueryData(queryKeys.companies.list("alice"))).toMatchObject({ companies: [{ id: "company-one" }] });
    expect(restored.client.getQueryData(inboxKey)).toEqual([{ id: "inbox-task", title: "First page" }]);
    expect(restored.client.getQueryData(queryKeys.plugins.uiContributions)).toMatchObject([{ displayName: "Example extension" }]);
    expect(hasUnverifiedSession(restored.client)).toBe(true);
    expect(bindAccount(restored.client).isCurrentAccount()).toBe(false);
  });

  it("does not hydrate another user's data into an already authenticated client", () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const client = new QueryClient();
    client.setQueryData(queryKeys.auth.session, session("bob"));
    setup(first.storage, undefined, client);
    expect(client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    expect(client.getQueryData(queryKeys.auth.session)).toMatchObject({ user: { id: "bob" } });
  });

  it("counts a task's UUID and identifier reads as one recent task", () => {
    const first = setup(); seed(first.client);
    for (let i = 0; i < 20; i += 1) {
      const task = { id: `task-${i}`, companyId: "company-one", title: `Recent task ${i}` };
      first.client.setQueryData([...queryKeys.issues.detail(task.id), "core"], task);
      first.client.setQueryData([...queryKeys.issues.detail(`TST-${i}`), "core"], task);
    }
    first.handle.flush();
    const restored = setup(first.storage);
    const details = restored.client.getQueryCache().getAll().filter(query => query.queryKey[0] === "issues" && query.queryKey[1] === "detail");
    expect(new Set(details.map(query => (query.state.data as { id: string }).id)).size).toBe(20);
    expect(details.length).toBeGreaterThan(20);
  });

  it("allows account-bound writes only after a fresh matching session", async () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const restored = setup(first.storage);
    const account = bindAccount(restored.client);
    let release!: (value: ReturnType<typeof session>) => void;
    auth.getSession.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const ready = account.whenAccountReady();
    expect(account.isCurrentAccount()).toBe(false);
    release(session());
    await ready;
    expect(hasUnverifiedSession(restored.client)).toBe(false);
    expect(account.isCurrentAccount()).toBe(true);
  });

  it("cancels the old owner's write scope and notifies observers when session verification finds another user", async () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const restored = setup(first.storage);
    const account = bindAccount(restored.client);
    const observer = new QueryObserver(restored.client, { queryKey: [...queryKeys.issues.detail("task-one"), "core"], enabled: false });
    const changes: unknown[] = [];
    const unsubscribe = observer.subscribe(result => changes.push(result.data));
    auth.getSession.mockResolvedValue(session("bob"));
    await account.whenAccountReady();
    expect(account.isCurrentAccount()).toBe(false);
    expect(account.isCurrentScope()).toBe(false);
    expect(restored.client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    expect(changes).toContain(undefined);
    expect([...restored.storage.values.values()].join(" ")).not.toContain("Saved task");
    unsubscribe();
  });

  it("enforces company ownership, exact allowlist entries and the recent-issue bound", () => {
    const first = setup(); seed(first.client);
    for (let i = 0; i < 25; i += 1) first.client.setQueryData([...queryKeys.issues.detail(`task-${i}`), "core"], { id: `task-${i}`, companyId: "company-one", title: `Task ${i}` });
    first.client.setQueryData([...queryKeys.issues.detail("foreign"), "core"], { id: "foreign", companyId: "other-company", title: "Private elsewhere" });
    first.handle.flush();
    const restored = setup(first.storage);
    const details = restored.client.getQueryCache().getAll().filter(query => query.queryKey[0] === "issues" && query.queryKey[1] === "detail");
    expect(details).toHaveLength(20);
    expect(restored.client.getQueryData([...queryKeys.issues.detail("foreign"), "core"])).toBeUndefined();
    expect(persistedQueryScope(["agents", "company-one", "keys"], [], "alice", ["company-one"])).toBeUndefined();
    expect(persistedQueryScope(["agent-chats", "company-one", "bob"], [], "alice", ["company-one"])).toBeUndefined();
  });

  it.each(["build", "expiry"])("discards snapshots after %s changes", kind => {
    const startedAt = Date.now();
    const first = setup(undefined, () => startedAt); seed(first.client); first.handle.flush();
    const restored = setup(first.storage, () => kind === "expiry" ? startedAt + QUERY_CACHE_MAX_AGE + 1 : startedAt, undefined, kind === "build" ? "build-two" : "build-one");
    expect(restored.client.getQueryData(queryKeys.auth.session)).toBeUndefined();
    expect([...restored.storage.values.keys()].filter(key => key.startsWith(QUERY_CACHE_PREFIX))).toHaveLength(0);
  });

  it("clears query records on sign-out, retains drafts and resumes caching only after a new verified login", async () => {
    const first = setup(); seed(first.client); first.handle.flush();
    first.storage.setItem("paperclip:private-draft", "draft retained");
    clearPersistedQueryCache(first.client);
    first.client.setQueryData(queryKeys.health, { status: "ok" });
    first.handle.flush();
    expect(first.storage.getItem(QUERY_CACHE_ACTIVE)).toBeNull();
    expect(first.storage.getItem("paperclip:private-draft")).toBe("draft retained");
    await first.client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: async () => session("bob"), staleTime: 0 });
    first.handle.flush();
    expect(first.storage.getItem(QUERY_CACHE_ACTIVE)).toBe("bob");
    expect([...first.storage.values.values()].join(" ")).not.toContain("Saved task");
  });

  it("keeps last good data for transient failures and removes a definitively denied task immediately", async () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const key = [...queryKeys.issues.detail("task-one"), "core"];
    await first.client.fetchQuery({ queryKey: key, queryFn: async () => { throw new ApiError("Restarting", 503, { error: "tenant_app_unavailable" }); } }).catch(() => {});
    first.handle.flush();
    expect([...first.storage.values.values()].join(" ")).toContain("Saved task");
    await first.client.fetchQuery({ queryKey: key, queryFn: async () => { throw new ApiError("Forbidden", 403, null); } }).catch(() => {});
    expect([...first.storage.values.values()].join(" ")).not.toContain("Saved task");
  });

  it("tolerates unavailable or corrupt storage", () => {
    const storage = new MemoryStorage();
    storage.setItem(QUERY_CACHE_ACTIVE, "alice");
    storage.setItem(`${QUERY_CACHE_PREFIX}alice:root`, "not json");
    expect(() => setup(storage)).not.toThrow();
    const client = new QueryClient();
    const handle = startPersistedQueryCache(client, { buildId: "build", storage: null, eventTarget: null });
    expect(() => { handle.flush(); handle.clear(); handle.dispose(); }).not.toThrow();
    client.clear();
  });

  it("clears saved account reads after a definitive session denial", async () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const account = bindAccount(first.client);
    await first.client.fetchQuery({ queryKey: queryKeys.auth.session, staleTime: 0,
      queryFn: async () => { throw new ApiError("Forbidden", 403, null); } }).catch(() => {});
    expect(first.client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    expect(first.client.getQueryData(queryKeys.auth.session)).toBeNull();
    expect(account.isCurrentScope()).toBe(false);
    expect([...first.storage.values.keys()].filter(key => key.startsWith(QUERY_CACHE_PREFIX))).toHaveLength(0);
  });

  it("does not restore fresh task data behind an expired saved identity", () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const rootKey = `${QUERY_CACHE_PREFIX}alice:root`;
    const root = JSON.parse(first.storage.getItem(rootKey)!);
    root.state.queries.find((query: { queryKey: string[] }) => query.queryKey[0] === "auth").state.dataUpdatedAt = Date.now() - QUERY_CACHE_MAX_AGE - 1;
    first.storage.setItem(rootKey, JSON.stringify(root));
    const restored = setup(first.storage);
    expect(restored.client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    expect(hasUnverifiedSession(restored.client)).toBe(false);
  });

  it("removes another tab's restored account data when that tab signs out", () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const client = new QueryClient();
    const events = new EventTarget();
    const handle = startPersistedQueryCache(client, { storage: first.storage, buildId: "build-one", eventTarget: events as Window });
    handles.push(() => { handle.dispose(); client.clear(); });
    const account = bindAccount(client);
    clearPersistedQueryCache(first.client);
    events.dispatchEvent(Object.assign(new Event("storage"), { key: QUERY_CACHE_CLEARED, newValue: "signed-out" }));
    expect(client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    expect(client.getQueryData(queryKeys.auth.session)).toBeNull();
    expect(account.isCurrentScope()).toBe(false);
    handle.flush();
    expect(first.storage.getItem(QUERY_CACHE_ACTIVE)).toBeNull();
  });
});
