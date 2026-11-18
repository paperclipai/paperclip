// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOnboardingOffers } from "@/lib/onboarding-auto-open";
import { ONBOARDING_AGENT_STEP } from "@/lib/onboarding-route";
import { useAgentlessOnboardingAutoOpen } from "./useAgentlessOnboardingAutoOpen";

const fixture = vi.hoisted(() => ({ agents: vi.fn(), openOnboarding: vi.fn(), pathname: "/PAP/responsibilities" }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: fixture.agents } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openOnboarding: fixture.openOnboarding }) }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname: fixture.pathname }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useAgentlessOnboardingAutoOpen();
  return null;
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOnboardingOffers();
  localStorage.clear();
});
afterEach(() => resetOnboardingOffers());

describe("useAgentlessOnboardingAutoOpen", () => {
  it("offers onboarding once for a company with no agent, from whichever page is home", async () => {
    fixture.agents.mockResolvedValue([]);
    let unmount = await mount();
    expect(fixture.openOnboarding).toHaveBeenCalledExactlyOnceWith({ companyId: "company-1", initialStep: ONBOARDING_AGENT_STEP });
    await unmount();

    // Coming back to the home page does not reopen a wizard that was closed.
    unmount = await mount();
    expect(fixture.openOnboarding).toHaveBeenCalledOnce();
    await unmount();
  });

  it("stays closed once the company has an agent", async () => {
    fixture.agents.mockResolvedValue([{ id: "agent-1", companyId: "company-1", status: "idle", pauseReason: null }]);
    const unmount = await mount();
    expect(fixture.openOnboarding).not.toHaveBeenCalled();
    await unmount();
  });
});
