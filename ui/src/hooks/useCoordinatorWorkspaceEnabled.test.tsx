// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCoordinatorWorkspaceEnabled } from "./useCoordinatorWorkspaceEnabled";
import { queryKeys } from "@/lib/queryKeys";

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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue(session("a"));
    mocks.health.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    mocks.get.mockResolvedValue(preference());
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });
  async function mount(provider = true) {
    flushSync(() => root.render(provider ? <QueryClientProvider client={client}><Probe /></QueryClientProvider> : <Probe />));
    await flush();
  }

  it("defaults off in detached hosts without fetching", async () => {
    await mount(false);
    expect(current).toMatchObject({ enabled: false, loaded: true });
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
  });
  it("switches only after save, and retains the saved choice when a later save fails", async () => {
    await mount();
    let resolve!: (value: ReturnType<typeof preference>) => void;
    mocks.update.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = current.setEnabled("company", true);
    await flush(); expect(current.enabled).toBe(false);
    resolve(preference("a", true)); await pending; await flush();
    expect(current.enabled).toBe(true);
    mocks.update.mockRejectedValueOnce(new Error("Save failed"));
    await expect(current.setEnabled("company", false)).rejects.toThrow("Save failed"); await flush();
    expect(current.enabled).toBe(true);
  });
  it("isolates cached choices and delayed save responses when accounts change", async () => {
    await mount();
    let resolve!: (value: ReturnType<typeof preference>) => void;
    mocks.update.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = current.setEnabled("company", true);
    mocks.get.mockResolvedValue(preference("b", false));
    client.setQueryData(queryKeys.auth.session, session("b")); await flush();
    resolve(preference("a", true)); await pending; await flush();
    expect(current).toMatchObject({ userId: "b", enabled: false });
    expect(client.getQueryData(queryKeys.workspacePreferences.mine("a"))).toMatchObject({ coordinatorWorkspaceEnabled: true });
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
    await mount(); expect(current).toMatchObject({ userId: null, enabled: false, loaded: true });
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("recognizes an explicitly local-trusted instance and fails closed on a read error", async () => {
    mocks.session.mockResolvedValue(null);
    mocks.health.mockResolvedValue({ status: "ok", deploymentMode: "local_trusted" });
    mocks.get.mockResolvedValue(preference("local-board", true));
    await mount(); expect(current).toMatchObject({ userId: "local-board", enabled: true });
    mocks.get.mockRejectedValue(new Error("Unavailable"));
    await client.invalidateQueries({ queryKey: queryKeys.workspacePreferences.mine("local-board") }); await flush();
    expect(current).toMatchObject({ enabled: false, loaded: true });
  });
});
