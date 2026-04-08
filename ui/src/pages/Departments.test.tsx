// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Departments } from "./Departments";

const treeMock = vi.fn();
const teamsListMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: unknown }) => (
    <a href={to} {...props}>{children as never}</a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../api/departments", () => ({
  departmentsApi: {
    tree: (companyId: string) => treeMock(companyId),
    create: vi.fn(),
  },
  teamsApi: {
    list: (companyId: string) => teamsListMock(companyId),
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

describe("Departments page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    treeMock.mockReset();
    teamsListMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders the department tree and team links", async () => {
    treeMock.mockResolvedValue([
      {
        id: "dept-1",
        companyId: "company-1",
        name: "Engineering",
        description: null,
        parentId: null,
        status: "active",
        sortOrder: 0,
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
        memberCount: 2,
        children: [
          {
            id: "dept-2",
            companyId: "company-1",
            name: "Platform",
            description: null,
            parentId: "dept-1",
            status: "active",
            sortOrder: 0,
            createdAt: "2026-04-08T00:00:00.000Z",
            updatedAt: "2026-04-08T00:00:00.000Z",
            memberCount: 1,
            children: [],
          },
        ],
      },
    ]);
    teamsListMock.mockResolvedValue([
      {
        id: "team-1",
        companyId: "company-1",
        departmentId: "dept-1",
        name: "Core Team",
        description: "Platform foundation",
        status: "active",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Departments />
        </QueryClientProvider>,
      );
      await flush();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Engineering");
      expect(container.textContent).toContain("Platform");
      expect(container.textContent).toContain("Core Team");
      expect(container.querySelector('a[href="/teams/team-1"]')).not.toBeNull();
    });

    await act(async () => {
      root.unmount();
    });
  });
});
