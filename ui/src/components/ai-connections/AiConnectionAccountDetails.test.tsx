// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiConnectionAccountIdentity, AiManagedConnectionSummary, ConnectionGrant, ToolConnection } from "@paperclipai/shared";
import { AiConnectionAccountDetails } from "./AiConnectionAccountDetails";
import { ManagedAiConnectionDetails } from "./ManagedAiConnectionDetails";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "user", settled: true }) }));

const account: AiManagedConnectionSummary = {
  id: "connection", grantId: "grant", companyId: "company", provider: "anthropic", method: "subscription",
  name: "Saved Claude", ownership: "personal", ownerName: "Sam", ownerUserId: "user", isDefault: true, status: "connected",
};
const grant = { id: account.grantId, updatedAt: new Date("2020-01-01T00:00:00.000Z"), capabilities: { canRevoke: true, canEditAudience: false } } as ConnectionGrant;
const known: AiConnectionAccountIdentity = { connectionId: account.id, grantId: grant.id, status: "available", accountLabel: "avery@example.test", organizationLabel: "Example team", checkedAt: "2020-01-01T00:00:00.000Z" };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
let observation: AiConnectionAccountIdentity;
let blocked: boolean;
let signals: AbortSignal[];
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  observation = known;
  blocked = false;
  signals = [];
  fetchMock.mockReset().mockImplementation((url: string, init: RequestInit) => {
    if (url.includes("/identity?")) {
      if (blocked) {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      }
      return Promise.resolve(Response.json(observation));
    }
    if (url.endsWith("/active-runs")) return Promise.resolve(Response.json([]));
    if (url.endsWith("/grants")) return Promise.resolve(Response.json({ currentUserId: "user", grants: [grant] }));
    return Promise.resolve(Response.json({ currentUserId: "user", connections: [account], pools: [], canManageConnections: true }));
  });
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: Infinity } } });
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

async function render(value = account, selectedGrant = grant, completePanel = false) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><TooltipProvider>{completePanel
      ? <ManagedAiConnectionDetails connection={{ id: value.id, companyId: value.companyId } as ToolConnection} />
      : <AiConnectionAccountDetails account={value} grant={selectedGrant} />}</TooltipProvider></QueryClientProvider>);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}
const identityCalls = () => fetchMock.mock.calls.filter(([url]) => url.includes("/identity?"));

it("shows the provider email and organization separately from the Paperclip owner", async () => {
  await render();
  expect(host.textContent).toContain("avery@example.test");
  expect(host.textContent).toContain("Example team");
  expect(host.textContent).toContain("Personal · Sam");
  expect(identityCalls()[0][0]).toBe("/api/companies/company/ai-connections/connection/identity?grantId=grant");
});

it("explains profile permission denial while preserving connected account controls", async () => {
  observation = { ...known, status: "unavailable", accountLabel: null, organizationLabel: null, errorCode: "permission_denied", message: "Anthropic did not permit this connection to read the account email." };
  await render(account, grant, true);
  expect(host.textContent).toContain("Default for Claude");
  expect(host.textContent).toContain("Reconnect");
  expect(host.textContent).toContain("did not permit");
  expect(host.textContent).not.toContain("avery@example.test");
  expect(host.textContent).not.toContain("Retry account check");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(identityCalls()).toHaveLength(1);
});

it("keeps maintenance controls visible during a stalled lookup and recovers only the identity request", async () => {
  blocked = true;
  await render(account, grant, true);
  expect(host.textContent).toContain("Default for Claude");
  expect(host.textContent).toContain("Reconnect");
  expect(host.textContent).toContain("Checking account details…");
  await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
  expect(signals[0].aborted).toBe(true);
  expect(host.textContent).toContain("Default for Claude");
  expect(host.textContent).not.toContain("Checking account details…");
  const ordinaryCalls = fetchMock.mock.calls.length - identityCalls().length;
  blocked = false;
  await act(async () => {
    [...host.querySelectorAll("button")].find(button => button.textContent === "Retry account check")!.click();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(host.textContent).toContain("avery@example.test");
  expect(fetchMock.mock.calls.length - identityCalls().length).toBe(ordinaryCalls);
});

it("does not show the previous credential's identity after the selected grant changes", async () => {
  await render();
  expect(host.textContent).toContain("avery@example.test");
  blocked = true;
  await render({ ...account, grantId: "other-grant" }, { ...grant, id: "other-grant" });
  expect(host.textContent).not.toContain("avery@example.test");
  expect(host.textContent).toContain("Checking account details…");
});

it("uses saved labels for unsupported methods without opening an identity request", async () => {
  await render({ ...account, method: "api_key", accountLabel: "billing@example.test", ownership: "shared" });
  expect(host.textContent).toContain("billing@example.test");
  expect(host.textContent).toContain("Company shared");
  expect(identityCalls()).toHaveLength(0);
});

it("reuses recent identity observations and invalidates them after reconnect", async () => {
  await render();
  await act(async () => { root.render(null); });
  await render();
  expect(identityCalls()).toHaveLength(1);
  observation = { ...known, accountLabel: "new-account@example.test" };
  await render(account, { ...grant, updatedAt: new Date("2020-01-02T00:00:00.000Z") });
  expect(identityCalls()).toHaveLength(2);
  expect(host.textContent).toContain("new-account@example.test");
  expect(host.textContent).not.toContain("avery@example.test");
});
