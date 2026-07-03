// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, ResourceMemberships } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProjects } from "./SidebarProjects";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockResourceMembershipsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  updateProject: vi.fn(),
}));

const mockOpenNewProject = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockPersistOrder = vi.hoisted(() => vi.fn());
const mockSidebarState = vi.hoisted(() => ({ isMobile: false, collapsed: false, peeking: false }));
const mockPointerState = vi.hoisted(() => ({ fine: true }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  NavLink: ({
    children,
    className,
    to,
    ...props
  }: {
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
    to: string;
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/PAP/projects/bravo/issues", search: "", hash: "", state: null }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP" },
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewProject: mockOpenNewProject,
  }),
  useDialogActions: () => ({
    openNewProject: mockOpenNewProject,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: mockSidebarState.isMobile,
    setSidebarOpen: mockSetSidebarOpen,
    collapsed: mockSidebarState.collapsed,
    peeking: mockSidebarState.peeking,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: mockResourceMembershipsApi,
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: Project[] }) => {
    const curatedOrder = ["project-b", "project-a", "project-c"];
    return {
      orderedProjects: [...projects].sort(
        (left, right) => curatedOrder.indexOf(left.id) - curatedOrder.indexOf(right.id),
      ),
      persistOrder: mockPersistOrder,
    };
  },
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({
    slots: [{ id: "slot-1", pluginKey: "plugin-1" }],
  }),
  PluginSlotMount: ({ context }: { context: { projectId: string } }) => (
    <div data-testid={`project-slot-${context.projectId}`}>Plugin slot</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: "project-a",
    companyId: "company-1",
    urlKey: "alpha",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Alpha",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#ef4444",
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project-a",
      effectiveLocalFolder: "/tmp/project-a",
      origin: "local_folder",
    },
    workspaces: [],
    primaryWorkspace: null,
    managedByPlugin: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function projectLinkLabels(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a[href$="/issues"]'))
    .map((anchor) => anchor.textContent?.replace("Plugin slot", "").trim())
    .filter(Boolean);
}

async function openProjectsMenu(container: HTMLElement) {
  const trigger = container.querySelector('button[aria-label="Projects section actions"]');
  expect(trigger).not.toBeNull();

  await act(async () => {
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function openProjectMenu(label = "Open actions for Alpha") {
  const trigger = document.body.querySelector(`button[aria-label="${label}"]`);
  expect(trigger).not.toBeNull();

  await act(async () => {
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function chooseSortMode(label: string) {
  const item = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-radio-item"]'))
    .find((element) => element.textContent?.includes(label));
  expect(item).toBeTruthy();

  await act(async () => {
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

describe("SidebarProjects", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;
  let memberships: ResourceMemberships;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    localStorage.clear();
    mockSidebarState.isMobile = false;
    mockSidebarState.collapsed = false;
    mockSidebarState.peeking = false;
    mockPointerState.fine = true;
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("(hover: hover)") && query.includes("(pointer: fine)")
          ? mockPointerState.fine
          : false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    mockProjectsApi.list.mockResolvedValue([
      makeProject({
        id: "project-a",
        urlKey: "alpha",
        name: "Alpha",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-05T00:00:00Z"),
      }),
      makeProject({
        id: "project-b",
        urlKey: "bravo",
        name: "Bravo",
        createdAt: new Date("2026-01-02T00:00:00Z"),
        updatedAt: new Date("2026-01-10T00:00:00Z"),
      }),
      makeProject({
        id: "project-c",
        urlKey: "charlie",
        name: "Charlie",
        createdAt: new Date("2026-01-03T00:00:00Z"),
        updatedAt: new Date("2026-01-12T00:00:00Z"),
      }),
    ]);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1" },
    });
    memberships = {
      projectMemberships: {},
      agentMemberships: {},
      updatedAt: null,
    };
    mockResourceMembershipsApi.listMine.mockImplementation(() => Promise.resolve(memberships));
    mockResourceMembershipsApi.updateProject.mockImplementation((_companyId, projectId, data) => {
      memberships = {
        ...memberships,
        projectMemberships: {
          ...memberships.projectMemberships,
          [projectId]: data.state,
        },
        updatedAt: new Date(),
      };
      return Promise.resolve({
        resourceType: "project",
        resourceId: projectId,
        state: data.state,
      });
    });
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    localStorage.clear();
    vi.clearAllMocks();
  });

  async function renderSidebarProjects() {
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProjects />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function renderRailSidebarProjects() {
    mockSidebarState.collapsed = true;
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarProjects />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders icon-only project rows with tooltips and no row actions in the rail", async () => {
    await renderRailSidebarProjects();

    // Project names stay in the a11y tree but kept in flow (zero-width, clipped)
    // so rows stay 1:1 tall with the expanded state (PAP-10676); rows become
    // tooltip triggers and the per-row actions dropdown is dropped.
    const nameSpan = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "Bravo");
    expect(nameSpan?.className).not.toContain("sr-only");
    expect(nameSpan?.className).toContain("w-0");
    expect(nameSpan?.className).toContain("overflow-hidden");
    const projectLink = container.querySelector('a[href^="/projects/"]');
    expect(projectLink?.parentElement?.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(container.querySelector('button[aria-label="Open actions for Bravo"]')).toBeNull();
    // The section header collapses to a divider (no section menu trigger).
    expect(container.querySelector('button[aria-label="Projects section actions"]')).toBeNull();
  });

  it("keeps top mode in curated order and renders plugin project slots", async () => {
    await renderSidebarProjects();

    expect(projectLinkLabels(container)).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(container.querySelector('[data-testid="project-slot-project-b"]')).toBeTruthy();
    expect(container.querySelector('[aria-roledescription="sortable"]')).toBeTruthy();
  });

  it("uses plain project rows for top mode on mobile", async () => {
    mockSidebarState.isMobile = true;

    await renderSidebarProjects();

    expect(projectLinkLabels(container)).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(container.querySelector('[aria-roledescription="sortable"]')).toBeNull();
  });

  it("uses plain project rows for top mode on coarse pointer screens", async () => {
    mockPointerState.fine = false;

    await renderSidebarProjects();

    expect(projectLinkLabels(container)).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(container.querySelector('[aria-roledescription="sortable"]')).toBeNull();
  });

  it("uses the heading for section menu and the plus button for project creation", async () => {
    await renderSidebarProjects();

    const sectionMenuTrigger = container.querySelector('button[aria-label="Projects section actions"]');
    expect(sectionMenuTrigger?.textContent).toContain("Projects");
    expect(sectionMenuTrigger?.querySelector("svg")).toBeNull();

    const newProjectButton = container.querySelector('button[aria-label="New project"]');
    expect(newProjectButton).toBeTruthy();
    await act(async () => {
      newProjectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockOpenNewProject).toHaveBeenCalledTimes(1);

    await openProjectsMenu(container);

    const newProjectItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("New project"));
    expect(newProjectItem).toBeFalsy();
    const browseLink = Array.from(document.body.querySelectorAll("a"))
      .find((element) => element.textContent?.includes("Browse projects"));
    expect(browseLink?.getAttribute("href")).toBe("/projects");
  });

  it("sorts alphabetically and persists the selected mode per company and user", async () => {
    await renderSidebarProjects();
    await openProjectsMenu(container);
    await chooseSortMode("Alphabetical");

    expect(projectLinkLabels(container)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(localStorage.getItem("paperclip.projectSortMode:company-1:user-1")).toBe("alphabetical");
  });

  it("sorts recent projects by updated time descending", async () => {
    await renderSidebarProjects();
    await openProjectsMenu(container);
    await chooseSortMode("Recent");

    expect(projectLinkLabels(container)).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("filters left projects only after membership state loads", async () => {
    let resolveMemberships!: (value: unknown) => void;
    mockResourceMembershipsApi.listMine.mockReturnValue(new Promise((resolve) => {
      resolveMemberships = resolve;
    }));

    await renderSidebarProjects();
    expect(projectLinkLabels(container)).toEqual(["Bravo", "Alpha", "Charlie"]);

    await act(async () => {
      resolveMemberships({
        projectMemberships: { "project-a": "left" },
        agentMemberships: {},
        updatedAt: null,
      });
    });
    await flushReact();

    expect(projectLinkLabels(container)).toEqual(["Bravo", "Charlie"]);
  });

  it("offers leave project from each sidebar project menu", async () => {
    await renderSidebarProjects();
    await openProjectMenu();

    const leaveItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Leave project"));
    expect(leaveItem).toBeTruthy();

    await act(async () => {
      leaveItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockResourceMembershipsApi.updateProject).toHaveBeenCalledWith(
      "company-1",
      "project-a",
      { state: "left" },
    );
    expect(projectLinkLabels(container)).toEqual(["Bravo", "Charlie"]);
  });
});
