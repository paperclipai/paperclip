// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCoordinatorWorkspaceEnabled } from "./useCoordinatorWorkspaceEnabled";
import { queryKeys } from "@/lib/queryKeys";
import { startPersistedQueryCache } from "@/lib/persisted-query-cache";
import { ApiError } from "@/api/client";

const mocks = vi.hoisted(() => ({ session: vi.fn(), health: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: mocks.session } }));
vi.mock("@/api/health", () => ({ healthApi: { get: mocks.health } }));
vi.mock("@/api/workspacePreferences", () => ({ workspacePreferencesApi: { get: mocks.get, update: mocks.update } }));

let current: ReturnType<typeof useCoordinatorWorkspaceEnabled>;
function Probe() { current = useCoordinatorWorkspaceEnabled(); return <span>{String(current.enabled)}</span>; }
const preference = (userId = "a", enabled = false) => ({ userId, coordinatorWorkspaceEnabled: enabled, updatedAt: null });
const session = (userId: string) => ({ user: { id: userId } });
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => window.setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("useCoordinatorWorkspaceEnabled", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  let cache: ReturnType<typeof startPersistedQueryCache> | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.session.mockResolvedValue(session("a"));
    mocks.health.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    mocks.get.mockResolvedValue(preference());
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { flushSync(() => root.unmount()); cache?.dispose(); cache = undefined; client.clear(); container.remove(); localStorage.clear(); vi.unstubAllGlobals(); });
  async function mount(provider = true) {
    flushSync(() => root.render(provider ? <QueryClientProvider client={client}><Probe /></QueryClientProvider> : <Probe />));
    await flush();
  }
  function restorePreference() {
    const source = new QueryClient();
    source.setQueryData(queryKeys.auth.session, session("a"));
    source.setQueryData(queryKeys.companies.list("a"), { companies: [{ id: "company", name: "Example" }], unauthorized: false });
    source.setQueryData(queryKeys.workspacePreferences.mine("a"), preference());
    const saved = startPersistedQueryCache(source, { storage: localStorage, buildId: "test", eventTarget: null });
    saved.flush(); saved.dispose(); source.clear();
    cache = startPersistedQueryCache(client, { storage: localStorage, buildId: "test", eventTarget: null });
    expect(client.getQueryData(queryKeys.workspacePreferences.mine("a"))).toEqual(preference());
  }

  it.each(["a", "b", null])("waits for fresh identity before changing a restored workspace preference (verified=%s)", async verified => {
    let finish!: (value: ReturnType<typeof session> | null) => void;
    mocks.session.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mocks.update.mockResolvedValue(preference("a", true));
    restorePreference();
    await mount();
    expect(current.userId).toBe("a");
    const pending = current.setEnabled("company", true).catch(error => error);
    await flush();
    try {
      expect(mocks.session).toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    } finally { finish(verified ? session(verified) : null); }
    const result = await pending;
    expect(mocks.update).toHaveBeenCalledTimes(verified === "a" ? 1 : 0);
    if (verified === "a") expect(result).toEqual(preference("a", true));
    else expect(result).toMatchObject({ name: "AbortError" });
  });

  it("does not save restored workspace preferences after session verification is denied", async () => {
    mocks.session.mockRejectedValue(new ApiError("Sign in again", 401, {}));
    restorePreference();
    await mount();
    await expect(current.setEnabled("company", true)).rejects.toBeDefined();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("uses Coordinator while a person's Classic choice is loading", async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(current).toMatchObject({ userId: "a", enabled: true, loaded: false });
  });

  it("defaults off in detached hosts without fetching", async () => {
    await mount(false);
    expect(current).toMatchObject({ enabled: false, loaded: true });
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
  });
  it("switches only after save, and retains the saved choice when a later save fails", async () => {
    await mount();
    let resolve!: (value: ReturnType<typeof preference>) => void;
    mocks.update.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = current.setEnabled("company", true).catch(error => error);
    await flush();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await flush(); expect(current.enabled).toBe(false);
    resolve(preference("a", true)); expect(await pending).toEqual(preference("a", true)); await flush();
    expect(current.enabled).toBe(true);
    mocks.update.mockRejectedValueOnce(new Error("Save failed"));
    await expect(current.setEnabled("company", false)).rejects.toThrow("Save failed"); await flush();
    expect(current.enabled).toBe(true);
  });
  it("isolates cached choices and delayed save responses when accounts change", async () => {
    await mount();
    let resolve!: (value: ReturnType<typeof preference>) => void;
    mocks.update.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = current.setEnabled("company", true).catch(error => error);
    await flush();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValue(preference("b", false));
    client.setQueryData(queryKeys.auth.session, session("b")); await flush();
    resolve(preference("a", true)); expect(await pending).toMatchObject({ name: "AbortError" }); await flush();
    expect(current).toMatchObject({ userId: "b", enabled: false });
    expect(client.getQueryData(queryKeys.workspacePreferences.mine("a"))).toMatchObject({ coordinatorWorkspaceEnabled: false });
  });
  it("loads the new account's saved choice while the previous account's real GET is still pending", async () => {
    const { workspacePreferencesApi } = await vi.importActual<typeof import("@/api/workspacePreferences")>("@/api/workspacePreferences");
    let resolvePrevious!: (response: Response) => void;
    const previous = new Promise<Response>(resolve => { resolvePrevious = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(previous).mockResolvedValueOnce(Response.json(preference("b", true)));
    vi.stubGlobal("fetch", fetchMock);
    mocks.get.mockImplementation(() => workspacePreferencesApi.get());
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    try {
      client.setQueryData(queryKeys.auth.session, session("b"));
      await vi.waitFor(() => expect(current).toMatchObject({ userId: "b", enabled: true, loaded: true }));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/workspace-preferences/me", "/api/workspace-preferences/me"]);
    } finally {
      resolvePrevious(Response.json(preference("a", false)));
      await flush();
    }
    expect(current).toMatchObject({ userId: "b", enabled: true });
    expect(client.getQueryData(queryKeys.workspacePreferences.mine("a"))).toMatchObject(preference("a", false));
    expect(client.getQueryData(queryKeys.workspacePreferences.mine("b"))).toMatchObject(preference("b", true));
  });
  it("does not treat anonymous sessions as local board, even with an enabled cached local choice", async () => {
    mocks.session.mockResolvedValue(null);
    client.setQueryData(queryKeys.workspacePreferences.mine("local-board"), preference("local-board", true));
    await mount(); expect(current).toMatchObject({ userId: null, enabled: true, loaded: true });
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("recognizes a local-trusted instance and keeps the standard workspace on a read error", async () => {
    mocks.session.mockResolvedValue(null);
    mocks.health.mockResolvedValue({ status: "ok", deploymentMode: "local_trusted" });
    mocks.get.mockResolvedValue(preference("local-board", true));
    await mount(); expect(current).toMatchObject({ userId: "local-board", enabled: true });
    mocks.get.mockRejectedValue(new Error("Unavailable"));
    await client.invalidateQueries({ queryKey: queryKeys.workspacePreferences.mine("local-board") }); await flush();
    expect(current).toMatchObject({ enabled: true, loaded: true });
  });
});
