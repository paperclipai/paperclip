// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProjects } from "./SidebarProjects";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
    status: "active",
    issuePrefix: "PAP",
  },
}));

const dialogState = vi.hoisted(() => ({
  openNewProject: vi.fn(),
}));

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: vi.fn(),
}));

const authApiMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const projectsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-one",
    code: null,
    parentId: null,
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project One",
    description: null,
    status: "planned",
    leadAgentId: null,
    targetDate: null,
    color: "#6366f1",
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: null,
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/PAP/dashboard" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

vi.mock("../api/auth", () => ({
  authApi: authApiMock,
}));

vi.mock("../api/projects", () => ({
  projectsApi: projectsApiMock,
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
    persistOrder: vi.fn(),
  }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("./BudgetSidebarMarker", () => ({
  BudgetSidebarMarker: () => null,
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>{children}</button>
  ),
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderSidebarProjects() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <SidebarProjects />
      </QueryClientProvider>,
    );
  });

  await flush();
}

beforeEach(() => {
  dialogState.openNewProject.mockReset();
  sidebarState.setSidebarOpen.mockReset();
  authApiMock.getSession.mockReset();
  projectsApiMock.list.mockReset();

  authApiMock.getSession.mockResolvedValue({ user: { id: "user-1" } });
  projectsApiMock.list.mockResolvedValue([]);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("SidebarProjects hierarchy", () => {
  it("renders project codes and nested children in hierarchy order", async () => {
    projectsApiMock.list.mockResolvedValue([
      makeProject({ id: "parent", name: "Platform", urlKey: "platform", code: "PLAT" }),
      makeProject({ id: "child", name: "Launch UI", urlKey: "launch-ui", code: "UI", parentId: "parent" }),
    ]);

    await renderSidebarProjects();

    expect(container?.textContent).toContain("PLAT");
    expect(container?.textContent).toContain("UI");
    expect(container?.textContent?.indexOf("Platform")).toBeLessThan(
      container?.textContent?.indexOf("Launch UI") ?? -1,
    );
  });

  it("indents child projects more than root projects", async () => {
    projectsApiMock.list.mockResolvedValue([
      makeProject({ id: "parent", name: "Platform", urlKey: "platform" }),
      makeProject({ id: "child", name: "Launch UI", urlKey: "launch-ui", parentId: "parent" }),
    ]);

    await renderSidebarProjects();

    const parentLink = container?.querySelector('a[href="/projects/platform/issues"]') as HTMLAnchorElement | null;
    const childLink = container?.querySelector('a[href="/projects/launch-ui/issues"]') as HTMLAnchorElement | null;

    expect(parentLink?.style.paddingLeft).toBe("0.75rem");
    expect(childLink?.style.paddingLeft).toBe("1.75rem");
  });
});
