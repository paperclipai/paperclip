// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agents } from "./Agents";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewAgent: vi.fn(),
}));

const breadcrumbsState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  org: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  list: vi.fn(),
  liveRunsForCompany: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbsState,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/agents/all", search: "", hash: "" }),
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>loading</div>,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ value: string; label: string }> }) => (
    <div>{items.map((item) => <span key={item.value}>{item.label}</span>)}</div>
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/EntityRow", () => ({
  EntityRow: ({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) => (
    <div>
      <div>{primary}</div>
      <div>{secondary}</div>
    </div>
  ),
}));

vi.mock("../components/AgentName", () => ({
  AgentName: ({ agent }: { agent: { name: string } }) => <span>{agent.name}</span>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderAgents(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Agents />
      </QueryClientProvider>,
    );
  });

  return { root };
}

describe("Agents page query mix", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockAgentsApi.list.mockReset();
    mockAgentsApi.org.mockReset();
    mockHeartbeatsApi.list.mockReset();
    mockHeartbeatsApi.liveRunsForCompany.mockReset();

    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", name: "QA Agent", status: "idle", role: "qa", adapterType: "codex_local" },
    ]);
    mockAgentsApi.org.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
  });

  it("uses live-runs instead of full heartbeat history", async () => {
    const { root } = renderAgents(container);

    await waitForAssertion(() => {
      expect(mockHeartbeatsApi.liveRunsForCompany).toHaveBeenCalledWith("company-1");
    });
    expect(mockHeartbeatsApi.list).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
