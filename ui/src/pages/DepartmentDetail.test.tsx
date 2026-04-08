// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DepartmentDetail } from "./DepartmentDetail";

const navigateMock = vi.fn();
const getDepartmentMock = vi.fn();
const listMembersMock = vi.fn();
const listAgentsMock = vi.fn();

vi.mock("@/lib/router", () => ({
  useParams: () => ({ departmentId: "dept-1" }),
  useNavigate: () => navigateMock,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../api/access", () => ({
  accessApi: {
    listMembers: vi.fn(async () => []),
  },
}));

vi.mock("../api/departments", () => ({
  departmentsApi: {
    getById: (id: string) => getDepartmentMock(id),
    listMembers: (id: string) => listMembersMock(id),
    update: vi.fn(),
    archive: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: unknown }) => (open ? <div>{children as never}</div> : null),
  DialogContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogHeader: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogTitle: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogFooter: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
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

describe("DepartmentDetail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    navigateMock.mockReset();
    getDepartmentMock.mockReset();
    listMembersMock.mockReset();
    listAgentsMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders member names from the agent directory instead of raw ids only", async () => {
    getDepartmentMock.mockResolvedValue({
      id: "dept-1",
      companyId: "company-1",
      name: "Engineering",
      description: "Core builders",
      parentId: null,
      status: "active",
      sortOrder: 0,
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
    });
    listMembersMock.mockResolvedValue([
      {
        id: "membership-1",
        companyId: "company-1",
        departmentId: "dept-1",
        principalType: "agent",
        principalId: "agent-1",
        role: "lead",
        createdAt: "2026-04-08T00:00:00.000Z",
      },
    ]);
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent One",
        urlKey: "agent-one",
        role: "engineer",
        title: "Platform Lead",
        icon: "code",
        status: "active",
        reportsTo: null,
        capabilities: "TypeScript",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        pauseReason: null,
        pausedAt: null,
        permissions: { canCreateAgents: false },
        lastHeartbeatAt: null,
        metadata: null,
        createdAt: new Date("2026-04-08T00:00:00.000Z"),
        updatedAt: new Date("2026-04-08T00:00:00.000Z"),
      },
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DepartmentDetail />
        </QueryClientProvider>,
      );
      await flush();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Engineering");
      expect(container.textContent).toContain("Agent One");
      expect(container.textContent).toContain("Platform Lead");
      expect(container.textContent).toContain("agent-1");
    });

    await act(async () => {
      root.unmount();
    });
  });
});
