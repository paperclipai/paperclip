// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimaryAgentProvider } from "./PrimaryAgentProvider";
import { usePrimaryAgentPresentation } from "@/components/primary-agent/PrimaryAgentPresentation";
import { queryKeys } from "@/lib/queryKeys";

const state = vi.hoisted(() => ({
  companyId: "company-a", get: vi.fn(), set: vi.fn(), session: vi.fn(), toast: vi.fn(),
}));
vi.mock("./CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("./ToastContext", () => ({ useToastActions: () => ({ pushToast: state.toast }) }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: state.session } }));
vi.mock("@/api/primaryAgent", () => ({ primaryAgentApi: { get: state.get, set: state.set } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async (companyId: string) => [
  { id: "maia", name: "Maia", companyId, status: "idle" },
  { id: "alex", name: "Alex", companyId, status: "idle" },
] } }));

let root: Root, container: HTMLDivElement, client: QueryClient;
const preference = (companyId = "company-a", userId = "user-a", primaryAgentId: string | null = "maia") => ({
  companyId, userId, primaryAgentId, initialized: true,
});
function Harness() {
  const value = usePrimaryAgentPresentation(state.companyId);
  return <>
    <output>{value?.loading ? "loading" : value?.error ? "error" : value?.primaryAgentId ?? "none"}</output>
    <button onClick={() => value?.onChange("alex")}>Choose Alex</button>
    <button onClick={() => value?.onRetry?.()}>Retry</button>
  </>;
}
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><PrimaryAgentProvider><Harness /></PrimaryAgentProvider></QueryClientProvider>));
}
async function waitForOutput(text: string) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.querySelector("output")?.textContent).toBe(text);
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.companyId = "company-a";
  state.get.mockReset().mockResolvedValue(preference());
  state.set.mockReset(); state.toast.mockReset();
  state.session.mockReset().mockResolvedValue({ user: { id: "user-a" } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals();
});

describe("primary agent persistence provider", () => {
  it("optimistically switches, restores the previous crown on failure, and offers a working retry", async () => {
    let reject!: (error: Error) => void;
    state.set.mockImplementationOnce(() => new Promise((_resolve, onReject) => { reject = onReject; }));
    await render(); await waitForOutput("maia");
    await act(async () => container.querySelector("button")!.click());
    await waitForOutput("alex");
    await act(async () => reject(new Error("Connection lost")));
    await waitForOutput("maia");
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error", body: "Connection lost" }));
    state.get.mockResolvedValue(preference("company-a", "user-a", "alex"));
    state.set.mockResolvedValue(preference("company-a", "user-a", "alex"));
    await act(async () => state.toast.mock.calls[0][0].action.onClick());
    await waitForOutput("alex");
    expect(state.set).toHaveBeenLastCalledWith("company-a", { primaryAgentId: "alex" });
  });

  it("keeps cached preferences separate across companies and users", async () => {
    await render(); await waitForOutput("maia");
    state.companyId = "company-b";
    state.get.mockResolvedValue(preference("company-b", "user-a", "alex"));
    await render(); await waitForOutput("alex");
    state.get.mockResolvedValue(preference("company-b", "user-b", null));
    await act(async () => client.setQueryData(queryKeys.auth.session, { user: { id: "user-b" } }));
    await waitForOutput("none");
    expect(client.getQueryData(queryKeys.primaryAgent.mine("company-a", "user-a"))).toEqual(preference());
    expect(client.getQueryData(queryKeys.primaryAgent.mine("company-b", "user-a"))).toEqual(preference("company-b", "user-a", "alex"));
    expect(client.getQueryData(queryKeys.primaryAgent.mine("company-b", "user-b"))).toEqual(preference("company-b", "user-b", null));
  });

  it("retries session failures before fetching a personal preference", async () => {
    state.session.mockRejectedValueOnce(new Error("Session unavailable"));
    await render(); await waitForOutput("error");
    expect(state.get).not.toHaveBeenCalled();
    await act(async () => container.querySelectorAll("button")[1].click());
    await waitForOutput("maia");
    expect(state.session).toHaveBeenCalledTimes(2);
  });
});
