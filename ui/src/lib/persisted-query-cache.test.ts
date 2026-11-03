import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { bindAccount } from "./account-scope";
import { hasUnverifiedSession } from "./cached-session";
import { queryKeys } from "./queryKeys";
import { agentConnection, agentDefaultModel } from "./bulk-agent-settings";
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

  it("strips embedded documents and capabilities from real task-shaped responses and nested inbox rows", () => {
    const first = setup(); seed(first.client);
    const task = { id: "task-one", companyId: "company-one", title: "Saved task", description: "Approved task description",
      planDocument: { id: "plan-one", key: "plan", format: "markdown", body: "excluded-plan-body" },
      legacyPlanDocument: { body: "excluded-legacy-body" }, documentSummaries: [{ key: "plan" }],
      workProducts: [{ type: "preview_url", url: "https://viewer.example.test/excluded-capability" }] };
    first.client.setQueryData([...queryKeys.issues.detail(task.id), "core"], task);
    first.client.setQueryData([...queryKeys.issues.listMineByMe("company-one"), "index", "with-routine-executions", "live-descendant-summary", 100, "alice"], [task]);
    first.client.setQueryData(queryKeys.agents.list("company-one"), [{ id: "agent-one", name: "Saved agent", adapterConfig: { provider: "codex", model: "display-model", Authorization: "excluded-header", access_token: "excluded-token" }, runtimeConfig: { env: { OPENAI_API_KEY: "excluded-env-token" } } }]);
    first.handle.flush();
    expect([...first.storage.values.values()].join(" ")).not.toMatch(/excluded-/);
    const key = `${QUERY_CACHE_PREFIX}alice:company-one`;
    const record = JSON.parse(first.storage.getItem(key)!);
    record.state.queries.find((query: { queryKey: string[] }) => query.queryKey[1] === "detail").state.data.planDocument = { body: "excluded-old-body" };
    first.storage.setItem(key, JSON.stringify(record));
    const restored = setup(first.storage);
    const cached = restored.client.getQueryData([...queryKeys.issues.detail(task.id), "core"]);
    expect(cached).toMatchObject({ description: "Approved task description" });
    expect(cached).not.toHaveProperty("planDocument");
    expect(cached).not.toHaveProperty("legacyPlanDocument");
    expect(cached).not.toHaveProperty("workProducts");
    const cachedAgents = restored.client.getQueryData<Agent[]>(queryKeys.agents.list("company-one"))!;
    expect(cachedAgents).toEqual([{ id: "agent-one", name: "Saved agent", adapterConfig: { provider: "codex", model: "display-model" }, runtimeConfig: {} }]);
    expect(agentDefaultModel(cachedAgents[0]!)).toBe("display-model");
    expect(agentConnection(cachedAgents[0]!)).toBeUndefined();
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

  it.each([{ status: 403, uncachedAlias: false }, { status: 404, uncachedAlias: false }, { status: 403, uncachedAlias: true }])("evicts UUID, identifier, core and inbox copies after a $status task denial (uncached alias=$uncachedAlias)", async ({ status, uncachedAlias }) => {
    const first = setup(); seed(first.client);
    const task = { id: "task-one", identifier: "TST-1", companyId: "company-one", title: "Denied task body" };
    const keys = [queryKeys.issues.detail(task.id), [...queryKeys.issues.detail(task.id), "core"],
      queryKeys.issues.detail(task.identifier), [...queryKeys.issues.detail(task.identifier), "core"]];
    for (const key of keys) first.client.setQueryData(key, task);
    first.client.setQueryData([...queryKeys.issues.listMineByMe("company-one"), "index", "with-routine-executions", "live-descendant-summary", 100, "alice"], [task]);
    first.handle.flush();
    await first.client.fetchQuery({ queryKey: uncachedAlias ? [...queryKeys.issues.detail("tst-1"), "core"] : keys[3]!, queryFn: async () => { throw new ApiError("Denied", status, null); } }).catch(() => {});
    for (const key of keys) expect(first.client.getQueryData(key)).toBeUndefined();
    expect([...first.storage.values.values()].join(" ")).not.toContain("Denied task body");
    const restored = setup(first.storage);
    for (const key of keys) expect(restored.client.getQueryData(key)).toBeUndefined();
    await first.client.fetchQuery({ queryKey: keys[3]!, queryFn: async () => ({ ...task, title: "Access restored" }) });
    first.handle.flush();
    expect([...first.storage.values.values()].join(" ")).toContain("Access restored");
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

  it("clears saved account data and publishes revocation even when storage is initially full", () => {
    const first = setup(); seed(first.client); first.handle.flush();
    let available = false;
    const set = first.storage.setItem.bind(first.storage);
    const remove = first.storage.removeItem.bind(first.storage);
    vi.spyOn(first.storage, "setItem").mockImplementation((key, value) => {
      if (!available) throw new Error("Quota exceeded");
      set(key, value);
    });
    vi.spyOn(first.storage, "removeItem").mockImplementation(key => { remove(key); available = true; });
    first.handle.clear();
    expect([...first.storage.values.keys()].filter(key => key.startsWith(QUERY_CACHE_PREFIX))).toHaveLength(0);
    expect(first.storage.getItem(QUERY_CACHE_CLEARED)).toContain('"alice"');
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

  it.each([QUERY_CACHE_CLEARED, "paperclip:query-cache-revision:alice"])("removes another tab's restored account data on the %s sign-out event", eventKey => {
    const first = setup(); seed(first.client); first.handle.flush();
    const client = new QueryClient();
    const events = new EventTarget();
    const handle = startPersistedQueryCache(client, { storage: first.storage, buildId: "build-one", eventTarget: events as Window });
    handles.push(() => { handle.dispose(); client.clear(); });
    const account = bindAccount(client);
    clearPersistedQueryCache(first.client);
    events.dispatchEvent(Object.assign(new Event("storage"), { key: eventKey, newValue: first.storage.getItem(eventKey) }));
    expect(client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    expect(client.getQueryData(queryKeys.auth.session)).toBeNull();
    expect(account.isCurrentScope()).toBe(false);
    handle.flush();
    expect(first.storage.getItem(QUERY_CACHE_ACTIVE)).toBeNull();
  });

  it.each(["sign-out", "session-ended"])("rejects a delayed tab flush and stale records after %s, while preserving a newer account", async ended => {
    const first = setup(); seed(first.client); first.handle.flush();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const events = new EventTarget();
    const second = startPersistedQueryCache(client, { storage: first.storage, buildId: "build-one", eventTarget: events as Window });
    handles.push(() => { second.dispose(); client.clear(); });
    await client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: async () => session(), staleTime: 0 });
    second.flush();
    const oldRecords = [...first.storage.values].filter(([key]) => key.startsWith(QUERY_CACHE_PREFIX));
    if (ended === "sign-out") first.handle.clear();
    else await first.client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: async () => null, staleTime: 0 });
    const token = first.storage.getItem(QUERY_CACHE_CLEARED);
    second.flush();
    expect(first.storage.getItem(QUERY_CACHE_ACTIVE)).toBeNull();
    for (const [key, value] of oldRecords) first.storage.setItem(key, value);
    const cold = setup(first.storage);
    expect(cold.client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    for (const [key, value] of oldRecords) first.storage.setItem(key, value);
    events.dispatchEvent(Object.assign(new Event("storage"), { key: QUERY_CACHE_CLEARED, newValue: token }));
    expect([...first.storage.values.keys()].filter(key => key.startsWith(QUERY_CACHE_PREFIX))).toHaveLength(0);
    const bob = new QueryClient();
    bob.setQueryData(queryKeys.auth.session, session("bob"));
    const fresh = setup(first.storage, undefined, bob);
    seed(bob, "bob", "company-two");
    fresh.handle.flush();
    events.dispatchEvent(Object.assign(new Event("storage"), { key: QUERY_CACHE_CLEARED, newValue: token }));
    expect(first.storage.getItem(QUERY_CACHE_ACTIVE)).toBe("bob");
    expect(first.storage.getItem(`${QUERY_CACHE_PREFIX}bob:root`)).toContain('"bob"');
  });
});
