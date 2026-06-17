// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  overview: vi.fn(),
  listOperations: vi.fn(),
  memoryQuery: vi.fn(),
  note: vi.fn(),
  updateBinding: vi.fn(),
  agentsList: vi.fn(),
}));

vi.mock("../api/memory", () => ({
  memoryApi: {
    overview: apiMocks.overview,
    listOperations: apiMocks.listOperations,
    query: apiMocks.memoryQuery,
    note: apiMocks.note,
    updateBinding: apiMocks.updateBinding,
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: apiMocks.agentsList },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", companies: [] }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
}));

import { MemoryPage } from "./MemoryPage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("MemoryPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    apiMocks.overview.mockResolvedValue({
      binding: { id: "binding-1", key: "default", provider: "gbrain", enabled: true, config: {} },
      providerAvailable: true,
      stats: {
        opsLast24h: 4,
        failuresLast24h: 1,
        lastHydrateAt: new Date("2026-06-10T00:00:00.000Z").toISOString(),
        lastCaptureAt: null,
      },
    });
    apiMocks.listOperations.mockResolvedValue({
      items: [
        {
          id: "op-1",
          operation: "query",
          hookKind: "pre_run_hydrate",
          intent: "agent_preamble",
          status: "succeeded",
          agentId: "agent-1",
          issueId: null,
          heartbeatRunId: "12345678-aaaa-bbbb-cccc-000000000001",
          usageJson: { latencyMs: 412, attributionMode: "included_in_run" },
          errorMessage: null,
          createdAt: new Date("2026-06-10T00:00:00.000Z").toISOString(),
          requestJson: null,
          resultJson: null,
        },
      ],
    });
    apiMocks.agentsList.mockResolvedValue([{ id: "agent-1", name: "Steve" }]);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("renders binding overview and the operations table", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryPage />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Memory");
    expect(text).toContain("gbrain (default)");
    expect(text).toContain("4 (1 failed)");
    expect(text).toContain("pre_run_hydrate");
    expect(text).toContain("succeeded");
    expect(text).toContain("Steve");
    expect(text).toContain("412 ms");
    expect(apiMocks.overview).toHaveBeenCalledWith("company-1");
    expect(apiMocks.listOperations).toHaveBeenCalledWith("company-1", { limit: 50 });

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
