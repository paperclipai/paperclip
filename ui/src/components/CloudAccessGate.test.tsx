// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { focusManager, onlineManager, QueryClientProvider, QueryObserver, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAccessGate } from "./CloudAccessGate";
import { ConnectionStatusBanner } from "./ConnectionStatusBanner";
import { ConnectivityProvider, createConnectivityStore, type ConnectivityStore } from "@/lib/connectivity";
import { bindConnectivity, createAppQueryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/queryKeys";
import { ApiUnavailableError } from "@/api/response";

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/CON/agents/conan/instructions", search: "?tab=edit", hash: "#draft" }),
  Navigate: ({ to }: { to: string }) => <div data-redirect={to} />,
  Outlet: () => <textarea aria-label="Instructions" defaultValue="Unsaved instructions" />,
}));
vi.mock("@/components/AnimatedPaperclipIcon", () => ({ PaperclipLoading: () => <div>Loading…</div> }));
vi.mock("@/components/CloudSignIn", () => ({ CloudSignIn: () => <div>Sign in to Cloud</div> }));
vi.mock("@/components/BootstrapPendingPage", () => ({ BootstrapPendingPage: () => <div>Set up instance</div> }));

const responses: Record<string, unknown> = {
  "/api/health": { status: "ok", deploymentMode: "authenticated", bootstrapStatus: "ready" },
  "/api/auth/get-session": {
    session: { id: "session", userId: "user" },
    user: { id: "user", name: "Operator", email: "operator@example.com", image: null },
    sentryDsn: null,
  },
  "/api/cli-auth/me": { isInstanceAdmin: false, companyIds: ["company"] },
};
const checks = [
  ["/api/health", queryKeys.health],
  ["/api/auth/get-session", queryKeys.auth.session],
  ["/api/cli-auth/me", queryKeys.access.currentBoardAccess],
] as const;

describe("CloudAccessGate restart recovery", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  let store: ConnectivityStore;
  let unbind: () => void;
  /** A single failing path, or every API path for a full outage. */
  let failingPath: string | null;
  let failure: () => Response;
  const fetchMock = vi.fn();

  const callsTo = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path).length;

  beforeEach(() => {
    vi.useFakeTimers();
    failingPath = null;
    failure = () => new Response("<!doctype html><h1>Restarting</h1>", { status: 200 });
    fetchMock.mockImplementation(async (path: string) => {
      if (failingPath === "*" || path === failingPath) return failure();
      if (!(path in responses)) throw new Error(`Unexpected request: ${path}`);
      return Response.json(responses[path]);
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // The app's real wiring: cache events feed the connectivity store, which
    // drives onlineManager and refreshes live queries on recovery.
    store = createConnectivityStore({ browserOnline: true });
    client = createAppQueryClient({ connectivity: store }, { defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    unbind = bindConnectivity(client, store);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    unbind();
    store.dispose();
    onlineManager.setOnline(true);
    client.clear();
    focusManager.setFocused(undefined);
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function flushReact() {
    await vi.advanceTimersByTimeAsync(20);
    flushSync(() => {});
  }

  async function render() {
    flushSync(() => root.render(
      <ConnectivityProvider store={store}>
        <QueryClientProvider client={client}>
          <ConnectionStatusBanner />
          <CloudAccessGate />
        </QueryClientProvider>
      </ConnectivityProvider>,
    ));
    await flushReact();
  }

  /** Long enough for the probe/retry backoff (1s, 2s, 5s, 10s) to reach its next step. */
  async function waitForReconnect() {
    await vi.advanceTimersByTimeAsync(16_000);
    await flushReact();
  }

  it.each(checks)("recovers from an HTML response on %s without navigating", async (path) => {
    failingPath = path;
    await render();
    expect(container.textContent).toContain("Reconnecting to Paperclip");
    expect(container.textContent).not.toContain("Unexpected token");
    expect(container.querySelector("[data-redirect]")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    // Backoff, not a tight loop: initial try plus retries at 1s and 3s.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(callsTo(path)).toBeLessThanOrEqual(path === "/api/health" ? 6 : 3);
    // The full-page screen already explains the outage.
    expect(container.querySelector("[data-connection-status]")).toBeNull();

    failingPath = null;
    await waitForReconnect();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.textContent).not.toContain("Reconnecting");
    const callsAfterRecovery = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterRecovery);
    expect(fetchMock.mock.calls.every(([, init]) => !init.method || init.method === "GET")).toBe(true);
  });

  it.each(checks)("preserves a mounted editor through an outage that starts on %s", async (path, queryKey) => {
    await render();
    const editor = container.querySelector("textarea")!;
    editor.value = "Keep my unsaved changes";
    failingPath = "*";
    failure = () => new Response("Bad gateway", { status: 502 });
    void client.refetchQueries({ queryKey });
    await flushReact();
    expect(container.querySelector("textarea")).toBe(editor);
    // One blip does not flash the banner; continued trouble does.
    expect(container.textContent).not.toContain("Reconnecting automatically");
    await vi.advanceTimersByTimeAsync(2_100);
    await flushReact();
    expect(container.textContent).toContain("Reconnecting automatically");
    expect(container.querySelector("textarea")).toBe(editor);

    failingPath = null;
    await waitForReconnect();
    expect(container.querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("Keep my unsaved changes");
    expect(container.textContent).not.toContain("Reconnecting");
    await vi.advanceTimersByTimeAsync(3_100);
    await flushReact();
    expect(container.querySelector("[data-connection-status]")).toBeNull();
  });

  it.each(checks)("reconnects %s as soon as a hidden tab is visible again", async (path) => {
    focusManager.setFocused(false);
    failingPath = path;
    await render();
    expect(container.textContent).toContain("Reconnecting to Paperclip");
    failingPath = null;
    await waitForReconnect();
    focusManager.setFocused(true);
    await flushReact();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("waits for ready health before opening the board even when access checks succeed", async () => {
    failingPath = "/api/health";
    failure = () => Response.json({ status: "starting", deploymentMode: "authenticated", bootstrapStatus: "ready" });
    await render();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Reconnecting");
    // The session is checked once; later checks wait for the server to be ready.
    expect(callsTo("/api/auth/get-session")).toBe(1);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(container.querySelector("textarea")).toBeNull();
    failingPath = null;
    await waitForReconnect();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.textContent).not.toContain("Reconnecting");
  });

  it("supports manual retry while startup health is pending", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: "starting", deploymentMode: "local_trusted" }));
    await render();
    expect(container.querySelector("textarea")).toBeNull();
    container.querySelector("button")!.click();
    await flushReact();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("preserves an open editor while health reports startup recovery", async () => {
    await render();
    const editor = container.querySelector("textarea")!;
    editor.value = "Keep my unsaved changes";
    failingPath = "/api/health";
    failure = () => Response.json({ status: "starting", deploymentMode: "authenticated", bootstrapStatus: "ready" });
    await client.refetchQueries({ queryKey: queryKeys.health });
    await vi.advanceTimersByTimeAsync(2_100);
    await flushReact();
    expect(container.querySelector("textarea")).toBe(editor);
    expect(container.textContent).toContain("Reconnecting automatically");
    failingPath = null;
    await waitForReconnect();
    expect(container.querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("Keep my unsaved changes");
    expect(container.textContent).not.toContain("Reconnecting");
  });

  it("offers immediate retry while waiting for the next automatic check", async () => {
    failingPath = "/api/health";
    await render();
    await vi.advanceTimersByTimeAsync(4_000);
    failingPath = null;
    container.querySelector("button")!.click();
    await flushReact();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("retries a dropped connection and opens the requested page when it returns", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await render();
    expect(container.textContent).toContain("Reconnecting to Paperclip");
    await vi.advanceTimersByTimeAsync(5_100);
    await flushReact();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector("[data-redirect]")).toBeNull();
  });

  it("refreshes other failed reads after the server recovers", async () => {
    const read = vi.fn().mockRejectedValueOnce(new ApiUnavailableError(503)).mockResolvedValue([]);
    const observer = new QueryObserver(client, { queryKey: ["companies", "test"], queryFn: read, retry: false });
    const unsubscribe = observer.subscribe(() => {});
    failingPath = "/api/health";
    await render();
    expect(read).toHaveBeenCalledTimes(1);
    failingPath = null;
    await waitForReconnect();
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().data).toEqual([]);
    unsubscribe();
  });

  it("fails closed for access denials even with cached access, and does not poll", async () => {
    await render();
    failingPath = "/api/cli-auth/me";
    failure = () => Response.json({ error: "Forbidden" }, { status: 403 });
    await client.refetchQueries({ queryKey: queryKeys.access.currentBoardAccess });
    await flushReact();
    expect(container.textContent).toContain("Unable to load Paperclip");
    expect(container.textContent).not.toContain("reconnect automatically");
    expect(container.querySelector("textarea")).toBeNull();
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    failingPath = null;
    container.querySelector("button")!.click();
    await flushReact();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("still redirects to sign-in when the session expires", async () => {
    await render();
    failingPath = "/api/auth/get-session";
    failure = () => Response.json({ error: "unauthorized" }, { status: 401 });
    await client.refetchQueries({ queryKey: queryKeys.auth.session });
    await flushReact();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("[data-redirect]")?.getAttribute("data-redirect"))
      .toBe("/auth?next=%2FCON%2Fagents%2Fconan%2Finstructions%3Ftab%3Dedit");
  });
});
