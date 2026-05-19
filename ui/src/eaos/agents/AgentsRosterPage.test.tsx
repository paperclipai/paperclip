// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const agentsListMock = vi.fn<(companyId: string) => Promise<Agent[]>>();

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => agentsListMock(companyId),
  },
}));

import { AgentsRosterPage } from "./AgentsRosterPage";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? "agent-1",
    companyId: "company-1",
    name: overrides.name ?? "EAOS Frontend Engineer",
    urlKey: overrides.urlKey ?? "frontend-engineer",
    role: overrides.role ?? "engineer",
    title: overrides.title ?? null,
    icon: null,
    status: overrides.status ?? "active",
    reportsTo: null,
    capabilities: null,
    adapterType: overrides.adapterType ?? "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: overrides.budgetMonthlyCents ?? 0,
    spentMonthlyCents: overrides.spentMonthlyCents ?? 0,
    pauseReason: overrides.pauseReason ?? null,
    pausedAt: overrides.pausedAt ?? null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Agent;
}

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  agentsListMock.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
  queryClient.clear();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 30) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function renderRoster(initialPath = "/eaos/agents") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const now = new Date("2026-05-19T16:00:00.000Z");
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/eaos/agents" element={<AgentsRosterPage now={now} />} />
            <Route path="/agents/:agentId" element={<div data-testid="kernel-agent-detail-stub" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("AgentsRosterPage (LET-503 cleanup)", () => {
  it("renders the roster surface, not the EaosZonePlaceholder", async () => {
    agentsListMock.mockResolvedValue([]);
    await renderRoster();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-agents-page"]')).not.toBeNull();
    });
    expect(container?.querySelector('[data-testid="eaos-zone-placeholder"]')).toBeNull();
  });

  it("renders a single-noun 'Agents' title with no read-only caveat paragraph", async () => {
    agentsListMock.mockResolvedValue([makeAgent()]);
    await renderRoster();
    await waitForMicrotaskAssertion(() => {
      const title = container?.querySelector('[data-testid="eaos-agents-title"]');
      expect(title?.textContent?.trim()).toBe("Agents");
    });
    const pageText = container?.querySelector('[data-testid="eaos-agents-page"]')?.textContent ?? "";
    expect(pageText).not.toContain("Agents / Teams");
    expect(pageText).not.toContain("Pause / resume / approve / terminate");
    expect(pageText).not.toContain("Shell · BACKEND-BACKED");
    expect(pageText).not.toContain("Data · BACKEND-BACKED");
  });

  it("renders agent rows in the table with backend-derived counts", async () => {
    agentsListMock.mockResolvedValue([
      makeAgent({ id: "ceo-1", name: "Andrii", role: "ceo", status: "active" }),
      makeAgent({ id: "eng-1", name: "Alex", role: "engineer", status: "running" }),
      makeAgent({ id: "eng-2", name: "Zelda", role: "engineer", status: "paused" }),
    ]);
    await renderRoster();
    await waitForMicrotaskAssertion(() => {
      const totalCell = container?.querySelector('[data-testid="eaos-agents-summary-total"]');
      const runningCell = container?.querySelector('[data-testid="eaos-agents-summary-running"]');
      const pausedCell = container?.querySelector('[data-testid="eaos-agents-summary-paused"]');
      expect(totalCell?.textContent).toContain("3");
      expect(runningCell?.textContent).toContain("1");
      expect(pausedCell?.textContent).toContain("1");

      const rows = container?.querySelectorAll('[data-testid="eaos-agents-row"]');
      expect(rows?.length).toBe(3);
      const runningRow = container?.querySelector('[data-agent-status="running"]');
      expect((runningRow?.textContent ?? "").toLowerCase()).toContain("running");
      const pausedRow = container?.querySelector('[data-agent-status="paused"]');
      expect((pausedRow?.textContent ?? "").toLowerCase()).toContain("paused");
    });
  });

  it("does not render any live action controls", async () => {
    agentsListMock.mockResolvedValue([makeAgent({ status: "running" })]);
    await renderRoster();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-agents-row"]')).not.toBeNull();
    });
    // Only navigation links to the kernel detail page; no buttons mutating state.
    const buttons = container?.querySelectorAll("button");
    expect(buttons?.length ?? 0).toBe(0);
    const kernelLink = container?.querySelector('[data-testid="eaos-agents-row-kernel-link"]');
    expect(kernelLink?.getAttribute("href")).toContain("/agents/");
  });

  it("falls back to the No company state when no company scope is selected", async () => {
    vi.doMock("@/context/CompanyContext", () => ({
      useCompany: () => ({ selectedCompany: null, selectedCompanyId: null }),
    }));
    vi.resetModules();
    const { AgentsRosterPage: ScopelessRoster } = await import("./AgentsRosterPage");
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/eaos/agents"]}>
            <Routes>
              <Route path="/eaos/agents" element={<ScopelessRoster />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-agents-no-company"]')).not.toBeNull();
    });
    vi.doUnmock("@/context/CompanyContext");
  });
});
