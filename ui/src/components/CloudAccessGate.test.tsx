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
  "/api/cli-auth/me": { userId: "user", isInstanceAdmin: false, companyIds: ["company"] },
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

  it("rechecks an expired session after board access returns 401", async () => {
    await render();
    expect(container.querySelector("textarea")).not.toBeNull();
    const previous = responses["/api/auth/get-session"];
    responses["/api/auth/get-session"] = null;
    failingPath = "/api/cli-auth/me";
    failure = () => Response.json({ error: "Unauthorized" }, { status: 401 });
    try {
      void client.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
      await flushReact();
      await flushReact();
      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector("[data-redirect]")?.getAttribute("data-redirect")).toContain("/auth?next=");
      expect(callsTo("/api/auth/get-session")).toBe(2);
    } finally { responses["/api/auth/get-session"] = previous; }
  });

  it("keeps a 403 closed without treating it as a logout", async () => {
    await render();
    failingPath = "/api/cli-auth/me";
    failure = () => Response.json({ error: "Forbidden" }, { status: 403 });
    void client.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    await flushReact();
    await flushReact();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Unable to load Paperclip");
    expect(container.querySelector("[data-redirect]")).toBeNull();
    expect(callsTo("/api/auth/get-session")).toBe(1);
  });

  it("rechecks the session again when retrying a persistent 401", async () => {
    await render();
    failingPath = "/api/cli-auth/me";
    failure = () => Response.json({ error: "Unauthorized" }, { status: 401 });
    void client.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    await flushReact();
    await flushReact();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Unable to load Paperclip");
    const previous = responses["/api/auth/get-session"];
    responses["/api/auth/get-session"] = null;
    try {
      flushSync(() => container.querySelector("button")!.click());
      await flushReact();
      await flushReact();
      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector("[data-redirect]")?.getAttribute("data-redirect")).toContain("/auth?next=");
    } finally { responses["/api/auth/get-session"] = previous; }
  });

  it("does not reopen access from a same-account bootstrap after a 401", async () => {
    await render();
    const previous = responses["/api/auth/get-session"];
    responses["/api/auth/get-session"] = { ...(previous as object), boardBootstrap: {
      userId: "user", companies: [], boardAccess: { userId: "user", isInstanceAdmin: false, companyIds: ["company"] },
    } };
    failingPath = "/api/cli-auth/me";
    failure = () => Response.json({ error: "Unauthorized" }, { status: 401 });
    try {
      void client.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
      await flushReact();
      await flushReact();
      expect(callsTo("/api/auth/get-session")).toBe(2);
      expect(container.querySelector("textarea")).toBeNull();
      expect(container.textContent).toContain("Unable to load Paperclip");
    } finally { responses["/api/auth/get-session"] = previous; }
  });

  it("keeps an initial access denial closed while retrying without cached access", async () => {
    const session = responses["/api/auth/get-session"] as object;
    let accessCalls = 0;
    let finishRetry!: (response: Response) => void;
    const retry = new Promise<Response>(resolve => { finishRetry = resolve; });
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/auth/get-session") return Response.json(callsTo(path) === 1 ? session : { ...session, boardBootstrap: {
        userId: "user", companies: [], boardAccess: { userId: "user", isInstanceAdmin: false, companyIds: ["company"] },
      } });
      if (path === "/api/cli-auth/me") return ++accessCalls === 1 ? Response.json({ error: "Unauthorized" }, { status: 401 }) : retry;
      return Response.json(responses[path]);
    });
    await render();
    await flushReact();
    expect(container.textContent).toContain("Unable to load Paperclip");
    flushSync(() => container.querySelector("button")!.click());
    await flushReact();
    expect(container.querySelector("textarea")).toBeNull();
    finishRetry(Response.json({ error: "Unauthorized" }, { status: 401 }));
    await flushReact();
    await flushReact();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Unable to load Paperclip");
    fetchMock.mockImplementation(async (path: string) => path === "/api/cli-auth/me"
      ? Response.json({ userId: "user", isInstanceAdmin: false, companyIds: ["company"] })
      : Response.json(responses[path]));
    flushSync(() => container.querySelector("button")!.click());
    await flushReact();
    await flushReact();
    expect(container.querySelector("textarea")).not.toBeNull();
    const boot = (userId: string, companyIds: string[]) => ({
      session: { id: `session-${userId}`, userId },
      user: { id: userId, name: "Operator", email: `${userId}@example.com`, image: null },
      boardBootstrap: { userId, companies: [], boardAccess: { userId, isInstanceAdmin: false, companyIds } },
    });
    client.setQueryData(queryKeys.auth.session, boot("other", ["other-company"]));
    await flushReact();
    client.setQueryData(queryKeys.auth.session, boot("user", []));
    await flushReact();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("No organization access");
  });

  it("honors a newer revoked snapshot before a delayed access success", async () => {
    const session = responses["/api/auth/get-session"] as object;
    let accessCalls = 0;
    let finishRetry!: (response: Response) => void;
    const retry = new Promise<Response>(resolve => { finishRetry = resolve; });
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/auth/get-session") return Response.json(callsTo(path) === 1 ? session : { ...session, boardBootstrap: {
        userId: "user", companies: [], boardAccess: { userId: "user", isInstanceAdmin: false, companyIds: ["company"] },
      } });
      if (path === "/api/cli-auth/me") return ++accessCalls === 1 ? Response.json({ error: "Unauthorized" }, { status: 401 }) : retry;
      return Response.json(responses[path]);
    });
    await render();
    await flushReact();
    expect(container.textContent).toContain("Unable to load Paperclip");
    flushSync(() => container.querySelector("button")!.click());
    await flushReact();
    client.setQueryData(queryKeys.auth.session, { ...session, boardBootstrap: {
      userId: "user", companies: [], boardAccess: { userId: "user", isInstanceAdmin: false, companyIds: [] },
    } });
    await flushReact();
    finishRetry(Response.json({ userId: "user", isInstanceAdmin: false, companyIds: ["company"] }));
    await flushReact();
    await flushReact();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("No organization access");
  });

  it("honors a revoked snapshot after a denied account's delayed success and account switch", async () => {
    const session = responses["/api/auth/get-session"] as object;
    let accessCalls = 0;
    let finishRetry!: (response: Response) => void;
    const retry = new Promise<Response>(resolve => { finishRetry = resolve; });
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/auth/get-session") return Response.json(session);
      if (path === "/api/cli-auth/me") return ++accessCalls === 1 ? Response.json({ error: "Unauthorized" }, { status: 401 }) : retry;
      return Response.json(responses[path]);
    });
    const boot = (userId: string, companyIds: string[]) => ({
      session: { id: `session-${userId}`, userId },
      user: { id: userId, name: "Operator", email: `${userId}@example.com`, image: null },
      boardBootstrap: { userId, companies: [], boardAccess: { userId, isInstanceAdmin: false, companyIds } },
    });
    await render();
    await flushReact();
    expect(container.textContent).toContain("Unable to load Paperclip");
    flushSync(() => container.querySelector("button")!.click());
    await flushReact();
    client.setQueryData(queryKeys.auth.session, boot("other", ["other-company"]));
    await flushReact();
    finishRetry(Response.json({ userId: "user", isInstanceAdmin: false, companyIds: ["old-company"] }));
    await flushReact();
    await flushReact();
    client.setQueryData(queryKeys.auth.session, boot("user", []));
    await flushReact();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("No organization access");
  });

  it.each(["401", "success"])("ignores a late %s from the previous account after an account change", async outcome => {
    await render();
    let rejectOld!: (response: Response) => void;
    const previousAccess = responses["/api/cli-auth/me"];
    const delayed = new Promise<Response>(resolve => { rejectOld = resolve; });
    fetchMock.mockImplementationOnce(async () => delayed);
    void client.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    await flushReact();
    responses["/api/cli-auth/me"] = { userId: "other", isInstanceAdmin: false, companyIds: [] };
    try {
      client.setQueryData(queryKeys.auth.session, {
        session: { id: "other-session", userId: "other" },
        user: { id: "other", name: "Other", email: "other@example.com", image: null },
      });
      await flushReact();
      rejectOld(outcome === "401"
        ? Response.json({ error: "Unauthorized" }, { status: 401 })
        : Response.json({ userId: "user", isInstanceAdmin: true, companyIds: ["old-company"] }));
      await flushReact();
      await flushReact();
      expect(container.querySelector("textarea")).toBeNull();
      expect(container.textContent).toContain("No organization access");
      expect(callsTo("/api/auth/get-session")).toBe(1);
      expect(client.getQueryData([...queryKeys.access.currentBoardAccess, "other"])).toMatchObject({ userId: "other", companyIds: [] });
    } finally { responses["/api/cli-auth/me"] = previousAccess; }
  });

  it("opens from same-session board access without another startup request", async () => {
    const previous = responses["/api/auth/get-session"];
    responses["/api/auth/get-session"] = { ...(previous as object), boardBootstrap: {
      userId: "user", companies: [], boardAccess: { userId: "user", isInstanceAdmin: false, companyIds: ["company"] },
    } };
    try {
      await render();
      expect(container.querySelector("textarea")).not.toBeNull();
      expect(callsTo("/api/cli-auth/me")).toBe(0);
      void client.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
      await flushReact();
      expect(callsTo("/api/cli-auth/me")).toBe(1);
    } finally { responses["/api/auth/get-session"] = previous; }
  });

  it("revokes cached board access when returning to an account with a new session snapshot", async () => {
    const previous = responses["/api/auth/get-session"];
    const boot = (userId: string, companyIds: string[]) => ({
      session: { id: `session-${userId}`, userId },
      user: { id: userId, name: "Operator", email: `${userId}@example.com`, image: null },
      sentryDsn: null,
      boardBootstrap: { userId, companies: [], boardAccess: { userId, isInstanceAdmin: false, companyIds } },
    });
    responses["/api/auth/get-session"] = boot("user", ["revoked-company"]);
    try {
      await render();
      expect(container.querySelector("textarea")).not.toBeNull();
      client.setQueryData(queryKeys.auth.session, boot("other", ["other-company"]));
      await flushReact();
      expect(container.querySelector("textarea")).not.toBeNull();
      client.setQueryData(queryKeys.auth.session, boot("user", []));
      await flushReact();
      expect(container.querySelector("textarea")).toBeNull();
      expect(client.getQueryData([...queryKeys.access.currentBoardAccess, "user"])).toMatchObject({ companyIds: [] });
      expect(callsTo("/api/cli-auth/me")).toBe(0);

      // An ordinary post-bootstrap grant is allowed to replace that snapshot.
      void client.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
      await flushReact();
      expect(callsTo("/api/cli-auth/me")).toBe(1);
      expect(container.querySelector("textarea")).not.toBeNull();
    } finally { responses["/api/auth/get-session"] = previous; }
  });

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
