import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, detachInflightGets } from "@/api/client";
import { bindAccount } from "./account-scope";
import { hasUnverifiedSession, markCachedSession } from "./cached-session";
import { queryKeys } from "./queryKeys";
import { readComposerRunSettings } from "../components/task-chat/composer-run-settings";
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
function setup(storage = new MemoryStorage(), now?: () => number, client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), buildId: string | null = "build-one") {
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
afterEach(() => { for (const dispose of handles.splice(0)) dispose(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("persisted read cache", () => {
  it("restores learned PR status and negative reads without invalidating their demand-driven freshness", () => {
    const first = setup(); seed(first.client);
    const key = queryKeys.linkPreview("company-one", "alice", "https://github.com/acme/web/pull/241");
    const result = { preview: { title: "Saved PR status", state: "merged" }, maxAgeMs: 60_000 };
    first.client.setQueryData(key, result);
    const absentKey = queryKeys.linkPreview("company-one", "alice", "https://github.com/acme/web/pull/242");
    first.client.setQueryData(absentKey, { preview: null, maxAgeMs: 60_000 });
    const updatedAt = first.client.getQueryState(key)!.dataUpdatedAt;
    first.handle.flush();
    const restored = setup(first.storage);
    expect(restored.client.getQueryData(key)).toEqual(result);
    expect(restored.client.getQueryData(absentKey)).toEqual({ preview: null, maxAgeMs: 60_000 });
    expect(restored.client.getQueryState(key)).toMatchObject({ dataUpdatedAt: updatedAt, isInvalidated: false });
  });

  it("persists PR reads only for the active viewer and an accessible company", () => {
    const first = setup(); seed(first.client);
    const url = "https://github.com/acme/web/pull/241";
    const result = { preview: { title: "Private PR" }, maxAgeMs: 60_000 };
    const forbidden = [
      queryKeys.linkPreview("company-one", "bob", url),
      queryKeys.linkPreview("other-company", "alice", url),
      ["link-preview", "company-one", null, url],
      ["link-preview", "company-one", "alice"],
      ["link-preview", "company-one", "alice", url, "extra"],
    ];
    for (const key of forbidden) first.client.setQueryData(key, result);
    first.handle.flush();
    expect([...first.storage.values.values()].join(" ")).not.toContain("Private PR");
    const restored = setup(first.storage);
    for (const key of forbidden) expect(restored.client.getQueryData(key)).toBeUndefined();
  });

  it("bounds saved PR reads and retains their original age through later saves", () => {
    let now = Date.now();
    const first = setup(undefined, () => now); seed(first.client);
    for (let i = 0; i < 120; i += 1) first.client.setQueryData(
      queryKeys.linkPreview("company-one", "alice", `https://github.com/acme/web/pull/${i + 1}`),
      { preview: { title: `PR ${i + 1}`, state: "open" }, maxAgeMs: 60_000 }, { updatedAt: now - 120 + i });
    first.handle.flush();
    const restored = setup(first.storage, () => now);
    expect(restored.client.getQueryCache().findAll({ queryKey: ["link-preview"] })).toHaveLength(100);
    expect(restored.client.getQueryData(queryKeys.linkPreview("company-one", "alice", "https://github.com/acme/web/pull/1"))).toBeUndefined();
    expect(restored.client.getQueryData(queryKeys.linkPreview("company-one", "alice", "https://github.com/acme/web/pull/120"))).toBeDefined();
    first.client.removeQueries({ queryKey: ["link-preview"] });
    now += 10 * 60_000;
    first.handle.flush();
    expect(setup(first.storage, () => now).client.getQueryCache().findAll({ queryKey: ["link-preview"] })).toHaveLength(100);
    now += QUERY_CACHE_MAX_AGE;
    first.client.setQueryData(queryKeys.auth.session, session(), { updatedAt: now });
    first.client.setQueryData(queryKeys.companies.list("alice"), { companies: [{ id: "company-one" }] }, { updatedAt: now });
    first.handle.flush();
    expect(setup(first.storage, () => now).client.getQueryCache().findAll({ queryKey: ["link-preview"] })).toHaveLength(0);
  });

  it.each(["sign-out", "account-change", "membership-loss"])("removes persisted private PR reads on %s", action => {
    const first = setup(); seed(first.client);
    const key = queryKeys.linkPreview("company-one", "alice", "https://github.com/acme/private/pull/241");
    first.client.setQueryData(key, { preview: { title: "Private PR status" }, maxAgeMs: 60_000 });
    first.handle.flush();
    expect([...first.storage.values.values()].join(" ")).toContain("Private PR status");
    if (action === "sign-out") clearPersistedQueryCache(first.client);
    if (action === "account-change") first.client.setQueryData(queryKeys.auth.session, session("bob"));
    if (action === "membership-loss") first.client.setQueryData(queryKeys.companies.list("alice"), { companies: [] });
    first.handle.flush();
    expect([...first.storage.values.values()].join(" ")).not.toContain("Private PR status");
    expect(setup(first.storage).client.getQueryData(key)).toBeUndefined();
  });

  it.each([null, "", "   "])("skips hydration and persistence without a build stamp (%s)", (buildId) => {
    const first = setup(); seed(first.client); first.handle.flush();
    const saved = new Map(first.storage.values);
    const restored = setup(first.storage, undefined, undefined, buildId);
    expect(restored.client.getQueryData(queryKeys.auth.session)).toBeUndefined();
    expect(restored.client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    seed(restored.client); restored.handle.flush();
    expect(first.storage.values).toEqual(saved);
    clearPersistedQueryCache(restored.client);
    expect([...first.storage.values.keys()].some(key => key.startsWith(QUERY_CACHE_PREFIX))).toBe(false);
  });

  it.each([QUERY_CACHE_CLEARED, "paperclip:query-cache-revision:alice"])("revokes a stamped tab through exported sign-out cleanup in an unstamped build (%s)", async eventKey => {
    const first = setup(); seed(first.client); first.handle.flush();
    first.storage.setItem("paperclip:private-draft", "draft retained");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const events = new EventTarget();
    const other = startPersistedQueryCache(client, { storage: first.storage, buildId: "build-one", eventTarget: events as Window });
    handles.push(() => { other.dispose(); client.clear(); });
    await client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: async () => session(), staleTime: 0 });
    const account = bindAccount(client);
    const unstamped = setup(first.storage, undefined, undefined, null);
    unstamped.client.setQueryData(queryKeys.auth.session, session());
    clearPersistedQueryCache(unstamped.client);
    expect(first.storage.getItem(eventKey)).not.toBeNull();
    expect([...first.storage.values.keys()].filter(key => key.startsWith(QUERY_CACHE_PREFIX))).toEqual([]);
    events.dispatchEvent(Object.assign(new Event("storage"), { key: eventKey, newValue: first.storage.getItem(eventKey) }));
    expect(client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    expect(client.getQueryData(queryKeys.auth.session)).toBeNull();
    expect(account.isCurrentScope()).toBe(false);
    other.flush();
    expect(first.storage.getItem(QUERY_CACHE_ACTIVE)).toBeNull();
    expect(first.storage.getItem("paperclip:private-draft")).toBe("draft retained");
  });

  it("rejects a stamped tab's delayed flush after unstamped sign-out before storage events arrive", async () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const other = setup(first.storage);
    await other.client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: async () => session(), staleTime: 0 });
    const unstamped = setup(first.storage, undefined, undefined, null);
    unstamped.client.setQueryData(queryKeys.auth.session, session());
    clearPersistedQueryCache(unstamped.client);
    other.handle.flush();
    expect(other.client.getQueryData(queryKeys.auth.session)).toBeNull();
    expect([...first.storage.values.keys()].filter(key => key.startsWith(QUERY_CACHE_PREFIX))).toEqual([]);
  });

  it("keeps recent task reads and company membership after actual five-minute memory garbage collection", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const key = [...queryKeys.issues.detail("task-one"), "core"];
    client.setQueryDefaults(key, { gcTime: 5 * 60_000 });
    client.setQueryDefaults(queryKeys.companies.list("alice"), { gcTime: 5 * 60_000 });
    const first = setup(undefined, undefined, client); seed(client); first.handle.flush();
    const observer = new QueryObserver(client, { queryKey: key, enabled: false });
    const unsubscribe = observer.subscribe(() => {});
    unsubscribe();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(queryKeys.companies.list("alice"))).toBeUndefined();
    client.setQueryData(queryKeys.health, { status: "ok", restarted: true });
    first.handle.flush();
    const restored = setup(first.storage);
    expect(restored.client.getQueryData(key)).toMatchObject({ title: "Saved task" });
    expect(restored.client.getQueryData(queryKeys.companies.list("alice"))).toMatchObject({ companies: [{ id: "company-one" }] });
  });

  it("expires retained task data from its original read time despite later snapshot writes", () => {
    vi.useFakeTimers();
    let now = Date.now();
    const first = setup(undefined, () => now); seed(first.client); first.handle.flush();
    const key = [...queryKeys.issues.detail("task-one"), "core"];
    first.client.removeQueries({ queryKey: key, exact: true });
    now += 5 * 60_000;
    first.handle.flush();
    expect([...first.storage.values.values()].join(" ")).toContain("Saved task");
    now += QUERY_CACHE_MAX_AGE;
    first.client.setQueryData(queryKeys.auth.session, session(), { updatedAt: now });
    first.client.setQueryData(queryKeys.companies.list("alice"), { companies: [{ id: "company-one" }] }, { updatedAt: now });
    first.handle.flush();
    expect([...first.storage.values.values()].join(" ")).not.toContain("Saved task");
    expect(setup(first.storage, () => now).client.getQueryData(key)).toBeUndefined();
  });

  it("applies the twenty-task limit across retained disk reads and newer live reads", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const first = setup(undefined, () => now); seed(first.client);
    first.client.removeQueries({ queryKey: queryKeys.issues.detail("task-one") });
    for (let i = 0; i < 20; i += 1) first.client.setQueryData([...queryKeys.issues.detail(`task-${i}`), "core"],
      { id: `task-${i}`, companyId: "company-one", title: `Retained task ${i}` }, { updatedAt: now - 20 + i });
    first.handle.flush();
    first.client.removeQueries({ queryKey: ["issues", "detail"] });
    first.client.setQueryData([...queryKeys.issues.detail("new-task"), "core"], { id: "new-task", companyId: "company-one", title: "Newest task" }, { updatedAt: now });
    first.handle.flush();
    const restored = setup(first.storage, () => now);
    const details = restored.client.getQueryCache().getAll().filter(query => query.queryKey[0] === "issues" && query.queryKey[1] === "detail");
    expect(details).toHaveLength(20);
    expect(restored.client.getQueryData([...queryKeys.issues.detail("task-0"), "core"])).toBeUndefined();
    expect(restored.client.getQueryData([...queryKeys.issues.detail("new-task"), "core"])).toMatchObject({ title: "Newest task" });
  });

  it.each([403, 404])("scrubs saved aliases and inbox rows after a %s denial following memory GC, even before session verification", async status => {
    const first = setup(); seed(first.client);
    const task = { id: "task-one", identifier: "TST-1", companyId: "company-one", title: "Denied task body" };
    const keys = [queryKeys.issues.detail(task.id), [...queryKeys.issues.detail(task.id), "core"],
      queryKeys.issues.detail(task.identifier), [...queryKeys.issues.detail(task.identifier), "core"]];
    for (const key of keys) first.client.setQueryData(key, task);
    const inboxKey = [...queryKeys.issues.listMineByMe("company-one"), "index", "with-routine-executions", "live-descendant-summary", 100, "alice"];
    first.client.setQueryData(inboxKey, [task, { id: "allowed-task", title: "Other task" }]);
    first.handle.flush();
    first.client.removeQueries({ queryKey: ["issues"] });
    markCachedSession(first.client);
    await first.client.fetchQuery({ queryKey: [...queryKeys.issues.detail("tst-1"), "core"], queryFn: async () => { throw new ApiError("Denied", status, null); } }).catch(() => {});
    expect(hasUnverifiedSession(first.client)).toBe(true);
    expect([...first.storage.values.values()].join(" ")).not.toContain("Denied task body");
    const restored = setup(first.storage);
    for (const key of keys) expect(restored.client.getQueryData(key)).toBeUndefined();
    expect(restored.client.getQueryData(inboxKey)).toEqual([{ id: "allowed-task", title: "Other task" }]);
  });

  it("removes retained company reads after fresh membership denial and does not resurrect them after memory GC", async () => {
    const first = setup(); seed(first.client); first.handle.flush();
    first.client.removeQueries({ queryKey: ["issues", "detail"] });
    const membership = queryKeys.companies.list("alice");
    await first.client.fetchQuery({ queryKey: membership, queryFn: async () => { throw new ApiError("Forbidden", 403, null); } }).catch(() => {});
    first.client.removeQueries({ queryKey: membership, exact: true });
    first.handle.flush();
    expect([...first.storage.values.values()].join(" ")).not.toContain("Saved task");
    expect(setup(first.storage).client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
  });

  it("replaces a retained disk task with a newer live read without persisting private fields", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const first = setup(undefined, () => now); seed(first.client); first.handle.flush();
    const key = [...queryKeys.issues.detail("task-one"), "core"];
    first.client.removeQueries({ queryKey: key, exact: true });
    first.client.setQueryData(key, { id: "task-one", companyId: "company-one", title: "Newer task", planDocument: { body: "excluded-new-document" } }, { updatedAt: now });
    first.handle.flush();
    const restored = setup(first.storage, () => now);
    expect(restored.client.getQueryData(key)).toMatchObject({ title: "Newer task" });
    expect(restored.client.getQueryData(key)).not.toHaveProperty("planDocument");
    expect([...first.storage.values.values()].join(" ")).not.toContain("excluded-new-document");
  });

  it("retains visible task run preferences while excluding private override options", () => {
    const first = setup(); seed(first.client);
    first.client.setQueryData([...queryKeys.issues.detail("task-one"), "core"], {
      id: "task-one", companyId: "company-one", title: "Saved task",
      assigneeAdapterOverrides: { useProjectWorkspace: true, adapterConfig: {
        model: "display-model", modelReasoningEffort: "high", fastMode: true,
        chrome: true, command: "excluded-command", env: { PRIVATE_VALUE: "excluded-env" },
      } },
    });
    first.handle.flush();
    expect([...first.storage.values.values()].join(" ")).not.toMatch(/excluded-|chrome/);
    const restored = setup(first.storage);
    const task = restored.client.getQueryData<{ assigneeAdapterOverrides: { adapterConfig: Record<string, unknown> } }>([...queryKeys.issues.detail("task-one"), "core"])!;
    expect(readComposerRunSettings(task.assigneeAdapterOverrides, "codex_local")).toEqual({ model: "display-model", effort: "high", fast: true });
    expect(task.assigneeAdapterOverrides.adapterConfig).not.toHaveProperty("command");
    expect(task.assigneeAdapterOverrides.adapterConfig).not.toHaveProperty("env");
  });

  it.each(["account-switch", "sign-out"])("does not share or persist another account's pending private-project request after %s", async boundary => {
    const first = setup(); seed(first.client); first.handle.flush();
    let finishAlice!: (value: Response) => void;
    const bobProjects = [{ id: "project-bob", companyId: "company-one", name: "Bob project" }];
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishAlice = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify(bobProjects), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    try {
      const key = queryKeys.projects.list("company-one");
      const path = "/companies/company-one/projects";
      // Match sidebar reads that do not forward React Query's AbortSignal.
      const oldRead = first.client.fetchQuery({ queryKey: key, queryFn: () => api.get(path) }).catch(() => undefined);
      expect(fetch).toHaveBeenCalledTimes(1);
      if (boundary === "sign-out") { clearPersistedQueryCache(first.client); first.client.clear(); }
      await first.client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: async () => session("bob"), staleTime: 0 });
      seed(first.client, "bob");
      const currentRead = first.client.fetchQuery({ queryKey: key, queryFn: () => api.get(path) });
      expect(fetch).toHaveBeenCalledTimes(2);
      await expect(currentRead).resolves.toEqual(bobProjects);
      finishAlice(new Response(JSON.stringify([{ id: "project-alice", companyId: "company-one", name: "Alice private project" }]), { headers: { "Content-Type": "application/json" } }));
      await oldRead;
      await Promise.resolve();
      first.handle.flush();
      expect(first.client.getQueryData(key)).toEqual(bobProjects);
      expect([...first.storage.values.values()].join(" ")).not.toContain("Alice private project");
      expect(setup(first.storage).client.getQueryData(key)).toEqual(bobProjects);
    } finally {
      finishAlice?.(new Response("[]", { headers: { "Content-Type": "application/json" } }));
      detachInflightGets(); vi.unstubAllGlobals();
    }
  });

  it("preserves another account published while this tab is flushing", () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const write = first.storage.setItem.bind(first.storage);
    const bobKey = `${QUERY_CACHE_PREFIX}bob:root`;
    const bobRecord = JSON.stringify({ userId: "bob", revision: null, state: { queries: [] } });
    let published = false;
    vi.spyOn(first.storage, "setItem").mockImplementation((key, value) => {
      write(key, value);
      if (!published && key === `${QUERY_CACHE_PREFIX}alice:root`) {
        published = true;
        write(bobKey, bobRecord);
        write(QUERY_CACHE_ACTIVE, "bob");
      }
    });
    first.handle.flush();
    expect(first.storage.getItem(bobKey)).toBe(bobRecord);
    expect(first.storage.getItem(QUERY_CACHE_ACTIVE)).toBe("bob");
    expect(first.client.getQueryData(queryKeys.auth.session)).toBeNull();
    expect(first.client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
  });

  it("removes every saved account record when native storage reorders keys during deletion", () => {
    const storage = new MemoryStorage();
    const remove = storage.removeItem.bind(storage);
    vi.spyOn(storage, "removeItem").mockImplementation(key => {
      remove(key);
      const entries = [...storage.values.entries()];
      if (entries.length > 1) entries.push(entries.shift()!);
      storage.values = new Map(entries);
    });
    const first = setup(storage); seed(first.client);
    first.client.setQueryData(queryKeys.companies.list("alice"), { companies: Array.from({ length: 8 }, (_, i) => ({ id: `company-${i}` })) });
    first.handle.flush();
    expect([...storage.values.keys()].filter(key => key.startsWith(QUERY_CACHE_PREFIX))).toHaveLength(10);
    first.handle.clear();
    expect([...storage.values.keys()].filter(key => key.startsWith(QUERY_CACHE_PREFIX))).toEqual([]);
    expect(storage.getItem(QUERY_CACHE_CLEARED)).toContain('"alice"');
  });

  it("refetches an active session after rejecting a pre-sign-out response without restoring saved reads", async () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const second = setup(first.storage);
    let release!: (value: ReturnType<typeof session>) => void;
    const lookup = vi.fn().mockImplementationOnce(() => new Promise<ReturnType<typeof session>>(resolve => { release = resolve; })).mockResolvedValue(null);
    const observer = new QueryObserver(second.client, { queryKey: queryKeys.auth.session, queryFn: lookup, staleTime: 0, retry: false });
    const unsubscribe = observer.subscribe(() => {});
    try {
      first.handle.clear();
      release(session());
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => { expect(observer.getCurrentResult().data).toBeNull(); expect(observer.getCurrentResult().isFetching).toBe(false); });
      second.handle.flush();
      expect(second.client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
      expect([...first.storage.values.keys()].filter(key => key.startsWith(QUERY_CACHE_PREFIX))).toEqual([]);
    } finally { unsubscribe(); }
  });

  it.each(["sign-out", "session-ended", "local-sign-out", "revision-only"])("rejects an older session response delivered before the %s storage event", async ended => {
    const first = setup(); seed(first.client); first.handle.flush();
    const second = ended === "local-sign-out" ? first : setup(first.storage);
    let release!: (value: ReturnType<typeof session>) => void;
    const read = second.client.fetchQuery({ queryKey: queryKeys.auth.session, staleTime: 0,
      queryFn: () => new Promise<ReturnType<typeof session>>(resolve => { release = resolve; }) });
    if (ended === "revision-only") {
      const write = first.storage.setItem.bind(first.storage);
      vi.spyOn(first.storage, "setItem").mockImplementation((key, value) => {
        if (key === QUERY_CACHE_CLEARED) throw new Error("Broadcast write failed");
        write(key, value);
      });
    }
    if (ended === "session-ended") await first.client.fetchQuery({ queryKey: queryKeys.auth.session, staleTime: 0, queryFn: async () => null });
    else first.handle.clear();
    release(session());
    await read;
    second.handle.flush();
    expect(second.client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    expect(second.client.getQueryData(queryKeys.auth.session)).toBeNull();
    expect([...first.storage.values.values()].join(" ")).not.toContain("Saved task");
    const cold = setup(first.storage);
    expect(cold.client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toBeUndefined();
    await second.client.fetchQuery({ queryKey: queryKeys.auth.session, staleTime: 0, queryFn: async () => session() });
    seed(second.client);
    second.client.setQueryData([...queryKeys.issues.detail("task-one"), "core"], { id: "task-one", companyId: "company-one", title: "Freshly authorized task" });
    second.handle.flush();
    expect([...first.storage.values.values()].join(" ")).toContain("Freshly authorized task");
  });

  it("restores a bounded first page of all legacy Inbox task queries", () => {
    const first = setup(); seed(first.client);
    const keys = [queryKeys.issues.list("company-one"), queryKeys.issues.listMineByMe("company-one"), queryKeys.issues.listTouchedByMe("company-one")]
      .map(key => [...key, "compact", "with-routine-executions", "live-descendant-summary", 500]);
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `legacy-${i}`, companyId: "company-one", title: `Legacy task ${i}`, planDocument: { body: "excluded-legacy-document" } }));
    for (const key of keys) first.client.setQueryData(key, rows);
    first.handle.flush();
    const restored = setup(first.storage);
    for (const key of keys) {
      expect(first.client.getQueryData(key)).toHaveLength(500);
      expect(restored.client.getQueryData(key)).toHaveLength(100);
      expect(restored.client.getQueryData(key)).toContainEqual({ id: "legacy-0", companyId: "company-one", title: "Legacy task 0" });
      expect(persistedQueryScope([...key, "extra"], rows, "alice", ["company-one"])).toBeUndefined();
    }
    expect([...first.storage.values.values()].join(" ")).not.toContain("excluded-legacy-document");
    const recordKey = `${QUERY_CACHE_PREFIX}alice:company-one`;
    const record = JSON.parse(first.storage.getItem(recordKey)!);
    for (const query of record.state.queries) if (query.queryKey.includes("compact")) query.state.data = rows;
    first.storage.setItem(recordKey, JSON.stringify(record));
    const older = setup(first.storage);
    for (const key of keys) expect(older.client.getQueryData(key)).toHaveLength(100);
  });

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

  it("ignores malformed saved queries while retaining valid recent reads on the next flush", () => {
    const first = setup(); seed(first.client); first.handle.flush();
    const key = `${QUERY_CACHE_PREFIX}alice:company-one`;
    const record = JSON.parse(first.storage.getItem(key)!);
    record.state.queries.push(null, {}, { queryKey: ["unapproved"], state: {} });
    first.storage.setItem(key, JSON.stringify(record));
    first.client.removeQueries({ queryKey: ["issues", "detail"] });
    expect(() => first.handle.flush()).not.toThrow();
    expect(setup(first.storage).client.getQueryData([...queryKeys.issues.detail("task-one"), "core"])).toMatchObject({ title: "Saved task" });
  });

  it("tolerates storage enumeration becoming unavailable before a flush", () => {
    const first = setup(); seed(first.client); first.handle.flush();
    vi.spyOn(first.storage, "length", "get").mockImplementation(() => { throw new Error("Storage unavailable"); });
    expect(() => first.handle.flush()).not.toThrow();
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
