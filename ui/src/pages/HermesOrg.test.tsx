// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HermesOrg } from "./HermesOrg";

const hermesOrgMock = vi.fn();

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    hermesOrg: () => hermesOrgMock(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("HermesOrg", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    hermesOrgMock.mockResolvedValue({
      orgKey: "full-lead-org",
      totalAgents: 64,
      activeAgents: 64,
      bridgeAgents: 64,
      runningRuns: 1,
      firstActivationPod: [
        {
          id: "agent-coo",
          name: "COO / Mission Control Lead",
          title: "COO / Mission Control Lead",
          profile: "leadcoo",
          division: "Executive / Coordination",
          status: "active",
          adapterType: "http",
          bridgeConnected: true,
          charter: "Own operating cadence.",
          cadence: "daily",
          skills: ["kanban-orchestrator"],
          review: ["Audit Lead"],
          lastHeartbeatAt: null,
          recentRuns: [],
        },
      ],
      divisions: [
        {
          name: "Executive / Coordination",
          agentCount: 8,
          activeCount: 8,
          runningRunCount: 1,
          agents: [
            {
              id: "agent-coo",
              name: "COO / Mission Control Lead",
              title: "COO / Mission Control Lead",
              profile: "leadcoo",
              division: "Executive / Coordination",
              status: "active",
              adapterType: "http",
              bridgeConnected: true,
              charter: "Own operating cadence.",
              cadence: "daily",
              skills: ["kanban-orchestrator"],
              review: ["Audit Lead"],
              lastHeartbeatAt: null,
              recentRuns: [{
                id: "run-1",
                status: "running",
                invocationSource: "on_demand",
                triggerDetail: "manual",
                startedAt: "2026-06-01T10:00:00.000Z",
                finishedAt: null,
                createdAt: "2026-06-01T09:59:58.000Z",
                error: null,
              }],
            },
          ],
        },
      ],
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root.unmount());
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <HermesOrg />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("renders operating org metrics, pod membership, reviews, and run status", async () => {
    await renderPage();

    expect(container.textContent).toContain("Hermes Operating Org");
    expect(container.textContent).toContain("64 lead agents");
    expect(container.textContent).toContain("64 bridge-connected");
    expect(container.textContent).toContain("First activation pod");
    expect(container.textContent).toContain("leadcoo");
    expect(container.textContent).toContain("Review: Audit Lead");
    expect(container.textContent).toContain("Executive / Coordination");
    expect(container.textContent).toContain("1 running");
  });
});
