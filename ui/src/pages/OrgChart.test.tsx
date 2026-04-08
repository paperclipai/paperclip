// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgChart } from "./OrgChart";

const navigateMock = vi.fn();
const orgMock = vi.fn();
const orgByDepartmentMock = vi.fn();
const agentsListMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: unknown }) => (
    <a href={to} {...props}>{children as never}</a>
  ),
  useNavigate: () => navigateMock,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    org: (companyId: string) => orgMock(companyId),
    orgByDepartment: (companyId: string) => orgByDepartmentMock(companyId),
    list: (companyId: string) => agentsListMock(companyId),
  },
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading...</div>,
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

describe("OrgChart", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    navigateMock.mockReset();
    orgMock.mockReset();
    orgByDepartmentMock.mockReset();
    agentsListMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("switches to grouped-by-department mode and renders department sections", async () => {
    orgMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "Agent One",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ]);
    orgByDepartmentMock.mockResolvedValue([
      {
        department: { id: "dept-1", name: "Engineering" },
        memberCount: 1,
        roots: [
          {
            id: "agent-1",
            name: "Agent One",
            role: "engineer",
            status: "active",
            reports: [],
          },
        ],
      },
    ]);
    agentsListMock.mockResolvedValue([
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent One",
        urlKey: "agent-one",
        role: "engineer",
        title: "Platform Engineer",
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
          <OrgChart />
        </QueryClientProvider>,
      );
      await flush();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Reporting hierarchy");
      expect(container.textContent).toContain("Agent One");
    });

    const groupedButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Grouped by department"),
    );
    expect(groupedButton).toBeTruthy();

    await act(async () => {
      groupedButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Engineering");
      expect(container.textContent).toContain("Agents grouped by owning department.");
    });

    await act(async () => {
      root.unmount();
    });
  });
});
