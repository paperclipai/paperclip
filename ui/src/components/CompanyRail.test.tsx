// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyRail } from "./CompanyRail";

const companyState = vi.hoisted(() => ({
  companies: [
    { id: "company-1", name: "Comandero", issuePrefix: "COM", status: "active", brandColor: "#22c55e", logoUrl: null },
    { id: "company-2", name: "Buildero", issuePrefix: "BLD", status: "active", brandColor: "#f97316", logoUrl: null },
  ],
  selectedCompanyId: "company-1",
  setSelectedCompanyId: vi.fn(),
}));

const dialogState = vi.hoisted(() => ({
  openOnboarding: vi.fn(),
}));

const mockCompaniesApi = vi.hoisted(() => ({
  railState: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockSidebarBadgesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/sidebarBadges", () => ({
  sidebarBadgesApi: mockSidebarBadgesApi,
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/COM/dashboard", search: "", hash: "" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  closestCenter: {},
  MouseSensor: function MouseSensor() {},
  useSensor: () => ({}),
  useSensors: () => ([]),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
  verticalListSortingStrategy: {},
  arrayMove: <T,>(items: T[]) => items,
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => "",
    },
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./CompanyPatternIcon", () => ({
  CompanyPatternIcon: () => <div>company</div>,
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

function renderRail(container: HTMLDivElement) {
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
        <CompanyRail />
      </QueryClientProvider>,
    );
  });

  return { root };
}

describe("CompanyRail query mix", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockCompaniesApi.railState.mockReset();
    mockHeartbeatsApi.liveRunsForCompany.mockReset();
    mockSidebarBadgesApi.get.mockReset();

    mockCompaniesApi.railState.mockResolvedValue([
      { companyId: "company-1", inboxCount: 2, hasLiveRuns: true },
      { companyId: "company-2", inboxCount: 0, hasLiveRuns: false },
    ]);
  });

  afterEach(() => {
    container.remove();
  });

  it("uses a single rail-state request instead of per-company polling fanout", async () => {
    const { root } = renderRail(container);

    await waitForAssertion(() => {
      expect(mockCompaniesApi.railState).toHaveBeenCalledTimes(1);
    });
    expect(mockHeartbeatsApi.liveRunsForCompany).not.toHaveBeenCalled();
    expect(mockSidebarBadgesApi.get).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
