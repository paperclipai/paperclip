// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  areaFundraising,
  areaLegal,
  areaPortfolio,
  fundraisingBehind,
  lpUpdatesStale,
  portfolioOnTrack,
  responsibilityOverviewFixture,
} from "../../storybook/fixtures/responsibilities";
import { Responsibilities } from "./Responsibilities";

const OVERVIEW = responsibilityOverviewFixture(
  [fundraisingBehind, lpUpdatesStale, portfolioOnTrack],
  [],
  { areas: [areaFundraising, areaPortfolio, areaLegal] },
);

const AGENTS: Agent[] = [
  { id: "agent-codex", name: "CodexCoder" } as Agent,
  { id: "agent-cto", name: "CTO" } as Agent,
];

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP" } }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/hooks/useResolvedViewerId", () => ({
  useResolvedViewerId: () => ({ userId: "user-storybook", error: null, retry: vi.fn() }),
}));

vi.mock("@/hooks/useAgentlessOnboardingAutoOpen", () => ({
  useAgentlessOnboardingAutoOpen: () => {},
}));

vi.mock("@/api/responsibilities", () => ({
  responsibilitiesApi: {
    overview: vi.fn(async () => OVERVIEW),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => AGENTS),
  },
}));

vi.mock("@/components/responsibilities/DashboardEditModule", () => ({
  DashboardEditModule: () => null,
}));

vi.mock("@/components/responsibilities/DashboardChatComposer", () => ({
  DashboardChatComposer: () => null,
}));

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Responsibilities routine filter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it("defaults to either, filters by Has routines or No routines via the filter popover, and clears back to either", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/PAP/responsibilities"]}>
            <Responsibilities />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();

    // Default: all 3 areas (including empty Legal) and all 3 responsibilities.
    await vi.waitFor(() => {
      expect(container.querySelector("[data-dashboard-counts]")?.textContent).toBe("3 areas and 3 responsibilities");
    });
    expect(container.querySelector('[data-responsibility-id="resp-fundraising"] [data-routine-agents="agent-codex"]')).not.toBeNull();
    expect(container.querySelector('[data-responsibility-id="resp-lp-updates"] [data-routine-agents]')).toBeNull();

    const filterBtn = container.querySelector<HTMLButtonElement>("[data-outline-v2-filter]");
    expect(filterBtn).not.toBeNull();
    expect(filterBtn?.getAttribute("data-active")).toBe("false");

    // Open filter popover.
    act(() => filterBtn!.click());
    await flush();

    const hasRoutines = document.body.querySelector<HTMLButtonElement>('button[role="checkbox"][aria-label="Has routines"]');
    const noRoutines = document.body.querySelector<HTMLButtonElement>('button[role="checkbox"][aria-label="No routines"]');
    expect(hasRoutines).not.toBeNull();
    expect(noRoutines).not.toBeNull();
    expect(hasRoutines?.getAttribute("aria-checked")).toBe("false");
    expect(noRoutines?.getAttribute("aria-checked")).toBe("false");

    // Select "Has routines".
    act(() => hasRoutines!.click());
    await flush();
    expect(filterBtn?.getAttribute("data-active")).toBe("true");
    expect(container.querySelector("[data-dashboard-counts]")?.textContent).toBe("2 areas and 2 responsibilities");
    expect(container.querySelector('[data-responsibility-id="resp-fundraising"]')).not.toBeNull();
    expect(container.querySelector('[data-responsibility-id="resp-portfolio"]')).not.toBeNull();
    expect(container.querySelector('[data-responsibility-id="resp-lp-updates"]')).toBeNull();

    // Switch to "No routines".
    act(() => noRoutines!.click());
    await flush();
    expect(container.querySelector("[data-dashboard-counts]")?.textContent).toBe("1 area and 1 responsibility");
    expect(container.querySelector('[data-responsibility-id="resp-lp-updates"]')).not.toBeNull();
    expect(container.querySelector('[data-responsibility-id="resp-fundraising"]')).toBeNull();

    // Click "No routines" again to toggle back to default (either).
    act(() => noRoutines!.click());
    await flush();
    expect(filterBtn?.getAttribute("data-active")).toBe("false");
    expect(container.querySelector("[data-dashboard-counts]")?.textContent).toBe("3 areas and 3 responsibilities");
    expect(container.querySelector('[data-responsibility-id="resp-fundraising"]')).not.toBeNull();
    expect(container.querySelector('[data-responsibility-id="resp-lp-updates"]')).not.toBeNull();
  });
});
