// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Agents } from "./Agents";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../context/ToastContext";

// Mock the API client
vi.mock("../api/client", () => ({
  agentsApi: {
    listAgents: vi.fn(() => Promise.resolve([])),
  },
}));

// Mock the agents API
vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(() => Promise.resolve([])),
    org: vi.fn(() => Promise.resolve([])),
  },
}));

// Mock the heartbeats API
vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForCompany: vi.fn(() => Promise.resolve([])),
  },
}));

// Mock useQuery to resolve synchronously for the Agents page queries
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...original,
    useQuery: vi.fn((options) => {
      const key = options.queryKey;
      if (Array.isArray(key) && (key.includes("agents") || key.includes("org") || key.includes("liveRuns"))) {
        return { data: [], isLoading: false, isSuccess: true, error: null };
      }
      return { data: undefined, isLoading: true, error: null };
    }),
  };
});

// Mock the adapter registry
vi.mock("../lib/adapterDisplayRegistry", () => ({
  getAdapterLabel: vi.fn((type) => type),
}));

// Mock the company context
vi.mock("../context/CompanyContext", () => ({
  useCompany: vi.fn(() => ({
    selectedCompanyId: "mock-company-id",
  })),
}));

// Mock the dialog context
vi.mock("../context/DialogContext", () => ({
  useDialogActions: vi.fn(() => ({
    openNewAgent: vi.fn(),
  })),
}));

// Mock the breadcrumb context
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: vi.fn(() => ({
    setBreadcrumbs: vi.fn(),
  })),
}));

// Mock the sidebar context
vi.mock("../context/SidebarContext", () => ({
  useSidebar: vi.fn(() => ({
    isMobile: false,
  })),
}));

describe("Agents Page", () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>{children}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );

  it("renders without crashing", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(wrapper({ children: <Agents /> }));
    });

    expect(container.textContent).toContain("Agent");
  });
});
