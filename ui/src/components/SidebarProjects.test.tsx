// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProjects } from "./SidebarProjects";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";

const navigateMock = vi.fn();

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
  create: vi.fn(),
  duplicate: vi.fn(),
}));

const projectQuickLinksApiMock = vi.hoisted(() => ({
  create: vi.fn(),
}));

const toastActionsMock = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const togglePinnedMock = vi.hoisted(() => vi.fn());

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
    labelIds: [],
    labels: [],
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
  useNavigate: () => navigateMock,
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

vi.mock("../api/projectQuickLinks", () => ({
  projectQuickLinksApi: projectQuickLinksApiMock,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => toastActionsMock,
}));

vi.mock("../hooks/useProjectPins", () => ({
  useProjectPins: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
    pinnedIds: [],
    togglePinned: togglePinnedMock,
  }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("./ProjectStarButton", () => ({
  ProjectStarButton: () => null,
}));

vi.mock("./ProjectLabelPills", () => ({
  ProjectLabelPills: () => null,
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

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

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
  navigateMock.mockReset();
  dialogState.openNewProject.mockReset();
  sidebarState.setSidebarOpen.mockReset();
  authApiMock.getSession.mockReset();
  projectsApiMock.list.mockReset();
  projectsApiMock.create.mockReset();
  projectsApiMock.duplicate.mockReset();
  projectQuickLinksApiMock.create.mockReset();
  toastActionsMock.pushToast.mockReset();
  togglePinnedMock.mockReset();

  authApiMock.getSession.mockResolvedValue({ user: { id: "user-1" } });
  projectsApiMock.list.mockResolvedValue([]);
  projectsApiMock.create.mockResolvedValue({
    id: "project-2",
    name: "paperclip",
    urlKey: "paperclip-project-2",
  });
  projectsApiMock.duplicate.mockResolvedValue({
    id: "project-copy",
    name: "Alpha Copy",
    urlKey: "alpha-copy-project-copy",
  });
  projectQuickLinksApiMock.create.mockResolvedValue({
    id: "link-1",
    title: "Paperclip",
    url: "http://roberts-mac-mini-2.tail3dddf6.ts.net:3100/projects/paperclip-project-2/issues",
  });
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

describe("SidebarProjects quick add", () => {
  it("shows project codes and searches by code", async () => {
    projectsApiMock.list.mockResolvedValue([
      makeProject({ id: "project-ops", name: "Operations", urlKey: "operations", code: "OPS7" }),
      makeProject({ id: "project-launch", name: "Launch", urlKey: "launch", code: "PAPA" }),
    ]);

    await renderSidebarProjects();

    expect(container?.textContent).toContain("OPS7");
    expect(container?.textContent).toContain("PAPA");

    const searchInput = container?.querySelector('input[aria-label="Search projects in sidebar"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      if (!searchInput) return;
      setInputValue(searchInput, "papa");
    });
    await flush();

    expect(container?.textContent).toContain("Launch");
    expect(container?.textContent).toContain("PAPA");
    expect(container?.textContent).not.toContain("Operations");
  });

  it("creates a project from a repo URL and navigates to it", async () => {
    await renderSidebarProjects();

    const openButton = container?.querySelector('button[aria-label="Quick add project"]') as HTMLButtonElement | null;
    expect(openButton).not.toBeNull();

    await act(async () => {
      openButton?.click();
    });

    const repoInput = container?.querySelector('input[aria-label="Project name or link"]') as HTMLInputElement | null;
    expect(repoInput).not.toBeNull();

    await act(async () => {
      if (!repoInput) return;
      setInputValue(repoInput, "https://github.com/paperclipai/paperclip.git");
    });

    const addButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Add",
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      addButton?.click();
    });
    await flush();

    expect(projectsApiMock.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      name: "paperclip",
      status: "planned",
      workspace: {
        name: "paperclip",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        isPrimary: true,
      },
    }));
    expect(projectQuickLinksApiMock.create).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith(
      "/projects/paperclip-project-2/issues",
      { state: SIDEBAR_SCROLL_RESET_STATE },
    );
  });

  it("creates a project from a plain name", async () => {
    await renderSidebarProjects();

    const openButton = container?.querySelector('button[aria-label="Quick add project"]') as HTMLButtonElement | null;

    await act(async () => {
      openButton?.click();
    });

    const input = container?.querySelector('input[aria-label="Project name or link"]') as HTMLInputElement | null;

    await act(async () => {
      if (!input) return;
      setInputValue(input, "Launch plan");
    });

    const addButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Add",
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      addButton?.click();
    });
    await flush();

    expect(projectsApiMock.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      name: "Launch plan",
      status: "planned",
    }));
    expect(projectsApiMock.create.mock.calls[0]?.[1]).not.toHaveProperty("workspace");
    expect(projectQuickLinksApiMock.create).not.toHaveBeenCalled();
  });

  it("creates a project and quick link from a Tailscale link", async () => {
    await renderSidebarProjects();

    const openButton = container?.querySelector('button[aria-label="Quick add project"]') as HTMLButtonElement | null;

    await act(async () => {
      openButton?.click();
    });

    const input = container?.querySelector('input[aria-label="Project name or link"]') as HTMLInputElement | null;
    const tailscaleUrl = "http://roberts-mac-mini-2.tail3dddf6.ts.net:3100/projects/client-portal/issues";

    await act(async () => {
      if (!input) return;
      setInputValue(input, tailscaleUrl);
    });

    const addButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Add",
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      addButton?.click();
    });
    await flush();

    expect(projectsApiMock.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      name: "Client Portal",
      status: "planned",
    }));
    expect(projectsApiMock.create.mock.calls[0]?.[1]).not.toHaveProperty("workspace");
    expect(projectQuickLinksApiMock.create).toHaveBeenCalledWith("company-1", "project-2", {
      url: tailscaleUrl,
    });
  });

  it("shows an inline validation error for an empty quick-add value", async () => {
    await renderSidebarProjects();

    const openButton = container?.querySelector('button[aria-label="Quick add project"]') as HTMLButtonElement | null;

    await act(async () => {
      openButton?.click();
    });

    const addButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Add",
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      addButton?.click();
    });
    await flush();

    expect(container?.textContent).toContain("Add a project name or link.");
    expect(projectsApiMock.create).not.toHaveBeenCalled();
  });

  it("keeps the full project dialog available from the quick-add UI", async () => {
    await renderSidebarProjects();

    const openButton = container?.querySelector('button[aria-label="Quick add project"]') as HTMLButtonElement | null;

    await act(async () => {
      openButton?.click();
    });

    const fullFormButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Full form",
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      fullFormButton?.click();
    });

    expect(dialogState.openNewProject).toHaveBeenCalledOnce();
  });

  it("duplicates a project from the sidebar and opens the empty copy", async () => {
    projectsApiMock.list.mockResolvedValue([
      {
        id: "project-1",
        companyId: "company-1",
        urlKey: "alpha-project-1",
        name: "Alpha",
        description: "Source project",
        status: "in_progress",
        color: "#6366f1",
        labels: [],
        goals: [],
        archivedAt: null,
        pauseReason: null,
        updatedAt: new Date("2026-04-20T12:00:00Z"),
      },
    ]);

    await renderSidebarProjects();

    const duplicateButton = container?.querySelector('button[aria-label="Duplicate Alpha"]') as HTMLButtonElement | null;
    expect(duplicateButton).not.toBeNull();

    await act(async () => {
      duplicateButton?.click();
    });
    await flush();

    expect(projectsApiMock.duplicate).toHaveBeenCalledWith("project-1", {}, "company-1");
    expect(toastActionsMock.pushToast).toHaveBeenCalledWith({
      title: "Project duplicated",
      body: "Tasks were not copied.",
      tone: "success",
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/projects/alpha-copy-project-copy/issues",
      { state: SIDEBAR_SCROLL_RESET_STATE },
    );
  });
});
