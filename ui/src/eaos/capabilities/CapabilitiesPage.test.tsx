// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

import { CapabilitiesPage } from "./CapabilitiesPage";

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    id: overrides.id,
    companyId: "company-1",
    name: overrides.name ?? "Agent",
    urlKey: overrides.urlKey ?? overrides.id,
    role: overrides.role ?? "engineer",
    title: overrides.title ?? null,
    icon: null,
    status: overrides.status ?? "active",
    reportsTo: null,
    capabilities: overrides.capabilities ?? null,
    adapterType: overrides.adapterType ?? "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
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

async function renderCapabilities() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/eaos/capabilities"]}>
          <Routes>
            <Route path="/eaos/capabilities" element={<CapabilitiesPage />} />
            <Route path="/agents/:agentId" element={<div data-testid="kernel-agent-detail-stub" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("CapabilitiesPage (LET-484 working-product slice)", () => {
  it("renders the capabilities surface (not the EaosZonePlaceholder)", async () => {
    agentsListMock.mockResolvedValue([]);
    await renderCapabilities();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-capabilities-page"]')).not.toBeNull();
    });
    expect(container?.querySelector('[data-testid="eaos-zone-placeholder"]')).toBeNull();
  });

  it("renders a clean single-word title and no internal posture chips", async () => {
    agentsListMock.mockResolvedValue([
      makeAgent({ id: "ag-1", adapterType: "claude_local", capabilities: "Frontend QA" }),
    ]);
    await renderCapabilities();
    await waitForMicrotaskAssertion(() => {
      const title = container?.querySelector('[data-testid="eaos-capabilities-title"]');
      expect(title?.textContent).toBe("Capabilities");
      const posture = container?.querySelector('[data-testid="eaos-capabilities-posture"]');
      expect(posture).toBeNull();
      const html = container?.innerHTML ?? "";
      expect(html).not.toContain("BACKEND-BACKED");
    });
  });

  it("groups adapters with counts and renders the per-agent capability section", async () => {
    agentsListMock.mockResolvedValue([
      makeAgent({ id: "1", adapterType: "claude_local", status: "active", capabilities: "Frontend QA" }),
      makeAgent({ id: "2", adapterType: "claude_local", status: "running" }),
      makeAgent({ id: "3", adapterType: "openai_remote", status: "active", capabilities: "Backend Python" }),
    ]);
    await renderCapabilities();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-capabilities-summary-agents"]')?.textContent).toContain("3");
      expect(container?.querySelector('[data-testid="eaos-capabilities-summary-adapters"]')?.textContent).toContain("2");

      const adapterRows = container?.querySelectorAll('[data-testid="eaos-capabilities-adapter-row"]');
      expect(adapterRows?.length).toBe(2);

      const agentRows = container?.querySelectorAll('[data-testid="eaos-capabilities-agent-row"]');
      expect(agentRows?.length).toBe(3);
    });
  });

  it("names the server-registry gap in customer-friendly copy (no jargon)", async () => {
    agentsListMock.mockResolvedValue([]);
    await renderCapabilities();
    await waitForMicrotaskAssertion(() => {
      const gap = container?.querySelector('[data-testid="eaos-capabilities-mcp-gap"]');
      const text = gap?.textContent ?? "";
      expect(text).toContain("Server registry");
      expect(text).toContain("coming soon");
      expect(text).not.toContain("Backend path pending");
      expect(text).not.toContain("/api/companies/:companyId/capabilities");
    });
  });

  it("does NOT render any live action buttons", async () => {
    agentsListMock.mockResolvedValue([
      makeAgent({ id: "a", adapterType: "claude_local" }),
    ]);
    await renderCapabilities();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-capabilities-agent-row"]')).not.toBeNull();
    });
    expect(container?.querySelectorAll("button").length).toBe(0);
    const kernelLink = container?.querySelector('[data-testid="eaos-capabilities-agent-link"]');
    expect(kernelLink?.getAttribute("href")).toBe("/LET/agents/a");
  });
});
