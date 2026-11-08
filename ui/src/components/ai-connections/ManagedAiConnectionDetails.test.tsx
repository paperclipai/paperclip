// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiManagedConnectionSummary, ToolConnection } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { authApi } from "@/api/auth";
import { ManagedAiConnectionDetails } from "./ManagedAiConnectionDetails";

vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn() } }));
vi.mock("./AiConnectionAccountControls", () => ({
  AiConnectionAccountControls: ({ account, grant }: { account: AiManagedConnectionSummary; grant: { id: string } }) => (
    <section aria-label="AI account settings" data-grant-id={grant.id}>{account.name}</section>
  ),
}));
vi.mock("./AiConnectionUsagePanel", () => ({ AiConnectionUsagePanel: () => null }));
vi.mock("./AiConnectionAccountDetails", () => ({ AiConnectionAccountDetails: () => null }));

const account: AiManagedConnectionSummary = {
  id: "connection", grantId: "grant", companyId: "company", provider: "anthropic", method: "subscription",
  name: "My account", ownership: "personal", isDefault: true, status: "connected",
};
const connection = { id: account.id, companyId: account.companyId } as ToolConnection;
const accounts = { currentUserId: "user", connections: [account], pools: [], canManageConnections: true };
const grants = { currentUserId: "user", grants: [{ id: account.grantId }] };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
let blocked: "accounts" | "grants" | null;
let denied: boolean;
let signals: AbortSignal[];
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  blocked = null;
  denied = false;
  signals = [];
  vi.mocked(authApi.getSession).mockReset().mockResolvedValue({ user: { id: "user" } } as Awaited<ReturnType<typeof authApi.getSession>>);
  fetchMock.mockReset().mockImplementation((url: string, init: RequestInit) => {
    if (url.endsWith("/active-runs")) return Promise.resolve(Response.json([]));
    const kind = url.endsWith("/grants") ? "grants" : "accounts";
    if (blocked === kind) {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }
    if (denied) return Promise.resolve(Response.json({ error: "Access denied" }, { status: 403 }));
    return Promise.resolve(Response.json(kind === "grants" ? grants : accounts));
  });
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: Infinity, retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render() {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><ManagedAiConnectionDetails connection={connection} /></QueryClientProvider>);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}

it("reuses the grants already loaded by the permissions page", async () => {
  client.setQueryData(queryKeys.tools.connectionGrants(account.id), grants);
  await render();
  expect(host.querySelector('[aria-label="AI account settings"]')?.textContent).toBe(account.name);
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/grants"))).toBe(false);
});

it("reports a failed session lookup and retries it before loading account data", async () => {
  vi.mocked(authApi.getSession).mockRejectedValueOnce(new Error("Session lookup failed"));
  await render();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Loading AI account…");
  expect(host.querySelector("button")?.textContent).toBe("Retry");
  const accountReads = () => fetchMock.mock.calls.filter(([url]) => url.endsWith("/ai-connections"));
  expect(accountReads()).toHaveLength(0);
  expect(client.getQueryData(["ai-connections", "company", undefined, null])).toBeUndefined();
  await act(async () => {
    host.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(10);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(authApi.getSession).toHaveBeenCalledTimes(2);
  expect(accountReads()).toHaveLength(1);
  expect(host.querySelector('[aria-label="AI account settings"]')?.textContent).toBe(account.name);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("waits for session recovery before retrying an earlier account error", async () => {
  await render();
  denied = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["ai-connections"] });
    await vi.advanceTimersByTimeAsync(10);
  });
  vi.mocked(authApi.getSession).mockRejectedValue(new Error("Session lookup failed"));
  await act(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.auth.session });
    await vi.advanceTimersByTimeAsync(10);
  });
  const calls = fetchMock.mock.calls.length;
  let recover!: (session: Awaited<ReturnType<typeof authApi.getSession>>) => void;
  vi.mocked(authApi.getSession).mockImplementation(() => new Promise(resolve => { recover = resolve; }));
  await act(async () => {
    host.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(fetchMock).toHaveBeenCalledTimes(calls);
  expect(host.querySelector('[aria-label="AI account settings"]')).toBeNull();
  denied = false;
  await act(async () => {
    recover({ user: { id: "user" } } as Awaited<ReturnType<typeof authApi.getSession>>);
    await vi.advanceTimersByTimeAsync(10);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(host.querySelector('[aria-label="AI account settings"]')?.textContent).toBe(account.name);
});

it.each(["personal", "shared", "missing-first"] as const)("keeps an accessible %s grant visible without a saved personal default", async mode => {
  const personal = { ...account, ownerUserId: "user", grantId: "personal-grant", name: "Personal account", isDefault: false };
  const shared = { ...account, ownership: "shared" as const, grantId: "shared-grant", name: "Shared account", isDefault: false };
  const other = { ...shared, grantId: "other-shared-grant", name: "Other shared account" };
  const choices = mode === "personal" ? [shared, personal] : [other, shared];
  const available = mode === "missing-first" ? [shared] : choices;
  fetchMock.mockImplementation((url: string) => Promise.resolve(Response.json(url.endsWith("/active-runs") ? []
    : url.endsWith("/grants") ? { ...grants, grants: available.map(choice => ({ id: choice.grantId })) }
      : { ...accounts, connections: choices })));
  await render();
  const expected = mode === "personal" ? personal : mode === "missing-first" ? shared : other;
  const controls = host.querySelector('[aria-label="AI account settings"]');
  expect(controls?.textContent).toBe(expected.name);
  expect(controls?.getAttribute("data-grant-id")).toBe(expected.grantId);
  expect(host.textContent).not.toContain("not available to you");
});

it.each(["accounts", "grants"] as const)("bounds a stuck %s read, retries once, and recovers from the retry button", async kind => {
  blocked = kind;
  await render();
  expect(host.textContent).toContain("Loading AI account…");
  await act(async () => { await vi.advanceTimersByTimeAsync(31_001); });
  expect(signals).toHaveLength(2);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(host.textContent).not.toContain("Loading AI account…");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("too long");
  expect(host.querySelector("button")?.textContent).toBe("Retry");
  blocked = null;
  await act(async () => {
    host.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(host.querySelector('[aria-label="AI account settings"]')?.textContent).toBe(account.name);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("shows an authorization failure without automatically retrying it", async () => {
  denied = true;
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Access denied");
  expect(host.textContent).not.toContain("Loading AI account…");
  const calls = fetchMock.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(31_001); });
  expect(fetchMock).toHaveBeenCalledTimes(calls);
});

it("keeps loaded controls visible when a background read fails", async () => {
  await render();
  denied = true;
  await act(async () => {
    await client.invalidateQueries();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(host.querySelector('[aria-label="AI account settings"]')?.textContent).toBe(account.name);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Access denied");
  expect(host.querySelector("button")?.textContent).toBe("Retry");
});

it("cancels a stuck account read when the panel unmounts", async () => {
  blocked = "accounts";
  await render();
  expect(signals).toHaveLength(1);
  await act(async () => { root.render(null); });
  expect(signals[0].aborted).toBe(true);
});
