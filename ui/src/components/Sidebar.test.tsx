// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
  }),
  useDialogActions: () => ({
    openNewIssue: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
  }),
}));

const mockSidebar = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: vi.fn(),
  collapsed: false,
  collapseLocked: false,
  peeking: false,
  toggleCollapsed: vi.fn(),
  setCollapsed: vi.fn(),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockSidebar,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: ({ slotTypes }: { slotTypes: string[] }) => (
    <div data-plugin-slot-types={slotTypes.join(",")}>Plugin slot outlet</div>
  ),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: ({ placementZones }: { placementZones: string[] }) => (
    <div data-plugin-launcher-zone={placementZones.join(",")}>Plugin launcher outlet</div>
  ),
}));

vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Company menu</div>,
}));

vi.mock("./SidebarAgents", () => ({
  SidebarAgents: ({ streamlined }: { streamlined?: boolean }) => (
    <div data-testid="sidebar-agents" data-streamlined={String(streamlined)} />
  ),
}));

vi.mock("./SidebarProjects", () => ({
  SidebarProjects: () => <div data-testid="sidebar-projects">Projects collapsible</div>,
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("Sidebar", () => {
  let container: HTMLDivElement;

  async function renderSidebar() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Sidebar />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    return root;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockSidebar.isMobile = false;
    mockSidebar.collapsed = false;
    mockSidebar.peeking = false;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("links the top search icon to the search page without showing Search in Work nav", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    const topSearchLink = container.querySelector('a[aria-label="Open search"]');
    expect(topSearchLink?.getAttribute("href")).toBe("/search");
    const workLinks = [...container.querySelectorAll("nav a")].map((anchor) => anchor.textContent?.trim());
    expect(workLinks).not.toContain("Search");

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders plugin sidebar launchers inside the Work section", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableStreamlinedLeftNavigation: true,
    });
    const root = await renderSidebar();

    const workSection = [...container.querySelectorAll("nav [data-plugin-launcher-zone]")]
      .find((node) => node.getAttribute("data-plugin-launcher-zone") === "sidebar");
    expect(workSection?.textContent).toContain("Plugin launcher outlet");
    const workSectionContainer = workSection?.parentElement?.parentElement;
    expect(workSectionContainer?.textContent).toContain("Work");
    expect(workSectionContainer?.textContent).toContain("Tasks");
    expect(workSectionContainer?.textContent).toContain("Goals");

    flushSync(() => {
      root.unmount();
    });
  });

  it("streamlined (flag ON): keeps Task wording, top-level Projects link, no per-project collapsible", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableStreamlinedLeftNavigation: true,
    });
    const root = await renderSidebar();

    expect(container.textContent).toContain("New Task");
    expect(container.textContent).not.toContain("New Issue");

    const navLabels = [...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim());
    expect(navLabels).toContain("Tasks");
    expect(navLabels).not.toContain("Issues");

    const projectsLink = [...container.querySelectorAll("nav a")].find((a) => a.textContent?.trim() === "Projects");
    expect(projectsLink?.getAttribute("href")).toBe("/projects");

    expect(container.querySelector('[data-testid="sidebar-projects"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-agents"]')?.getAttribute("data-streamlined"),
    ).toBe("true");

    flushSync(() => {
      root.unmount();
    });
  });

  it("classic (flag OFF): Task wording, per-project collapsible, no top-level Projects", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableStreamlinedLeftNavigation: false,
      enablePipelines: false,
    });
    const root = await renderSidebar();

    expect(container.textContent).toContain("New Task");
    expect(container.textContent).not.toContain("New Issue");

    const navLabels = [...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim());
    expect(navLabels).toContain("Tasks");
    expect(navLabels).not.toContain("Issues");
    expect(navLabels).not.toContain("Review queue");
    expect(navLabels).not.toContain("Pipelines");
    expect(navLabels).not.toContain("Learnings");
    // No top-level Projects nav link in classic mode (D5 option A).
    expect(navLabels).not.toContain("Projects");

    // Per-project collapsible restored below Work.
    expect(container.querySelector('[data-testid="sidebar-projects"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-agents"]')?.getAttribute("data-streamlined"),
    ).toBe("false");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows pipeline navigation only when the pipelines experimental flag is enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enablePipelines: true,
    });
    const root = await renderSidebar();

    const navLabels = [...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim());
    expect(navLabels).toContain("Review queue");
    expect(navLabels).toContain("Pipelines");
    expect(navLabels).toContain("Learnings");

    const pipelinesLink = [...container.querySelectorAll("nav a")].find(
      (anchor) => anchor.textContent?.trim() === "Pipelines",
    );
    expect(pipelinesLink?.getAttribute("href")).toBe("/pipelines");

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders plugin sidebar slots in Work below Workspaces", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = await renderSidebar();

    const sidebarSlot = [...container.querySelectorAll("nav [data-plugin-slot-types]")]
      .find((node) => node.getAttribute("data-plugin-slot-types") === "sidebar");
    expect(sidebarSlot?.textContent).toContain("Plugin slot outlet");
    const workSectionContainer = sidebarSlot?.parentElement?.parentElement;
    const workText = workSectionContainer?.textContent ?? "";
    expect(workText).toContain("Work");
    expect(workText).toContain("Workspaces");
    expect(workText.indexOf("Workspaces")).toBeLessThan(workText.indexOf("Plugin slot outlet"));

    const primaryNavText = container.querySelector("nav > div:first-child")?.textContent ?? "";
    expect(primaryNavText).toContain("Inbox");
    expect(primaryNavText).not.toContain("Plugin slot outlet");

    flushSync(() => {
      root.unmount();
    });
  });

  it("does not flash the Workspaces link while experimental settings are loading", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = await renderSidebar();

    expect(container.textContent).not.toContain("Workspaces");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows an Artifacts nav item directly below Goals", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    const artifactsLink = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Artifacts",
    );
    expect(artifactsLink?.getAttribute("href")).toBe("/artifacts");

    const navText = container.querySelector("nav")?.textContent ?? "";
    expect(navText).toContain("Goals");
    expect(navText).toContain("Artifacts");
    expect(navText.indexOf("Goals")).toBeLessThan(navText.indexOf("Artifacts"));

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the Workspaces link when isolated workspaces are enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = await renderSidebar();

    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Workspaces");
    expect(link?.getAttribute("href")).toBe("/workspaces");

    flushSync(() => {
      root.unmount();
    });
  });

  it("header toggle collapses an expanded sidebar (aria-expanded reflects state)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");

    flushSync(() => {
      toggle?.click();
    });
    expect(mockSidebar.toggleCollapsed).toHaveBeenCalledTimes(1);

    flushSync(() => {
      root.unmount();
    });
  });

  it("hides the expand/collapse toggle while a secondary sidebar locks the rail", async () => {
    // A secondary sidebar forces the rail; the user must not be able to expand
    // the primary while it is shown (PAP-10694).
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockSidebar.collapseLocked = true;
    const root = await renderSidebar();

    expect(container.querySelector('button[aria-label="Collapse sidebar"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).toBeNull();

    mockSidebar.collapseLocked = false;
    flushSync(() => {
      root.unmount();
    });
  });

  it("keeps the collapsed rail top bar to just the company logo (no clipped search/toggle)", async () => {
    // In the narrow rail the search/toggle controls don't fit beside the logo and
    // would overflow/clip, shoving the logo out of the icon column (PAP-10676), so
    // they are dropped in the rail. Expansion stays reachable via hover-peek + Pin
    // and Cmd/Ctrl+B. The full controls return as soon as the panel is expanded or
    // peeking (covered by the other top-bar tests).
    mockSidebar.collapsed = true;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    expect(container.querySelector('button[aria-label="Expand sidebar"]')).toBeNull();
    expect(container.querySelector('a[aria-label="Open search"]')).toBeNull();
    // The company menu (workspace switcher / logo) is still present in the rail.
    expect(container.textContent).toContain("Company menu");

    flushSync(() => {
      root.unmount();
    });
  });

  it("peek header shows a pin that promotes the peek to pinned-expanded", async () => {
    mockSidebar.collapsed = true;
    mockSidebar.peeking = true;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    // The collapse toggle is replaced by the pin while peeking.
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).toBeNull();
    const pin = container.querySelector<HTMLButtonElement>('button[aria-label="Keep sidebar expanded"]');
    expect(pin).not.toBeNull();

    flushSync(() => {
      pin?.click();
    });
    expect(mockSidebar.setCollapsed).toHaveBeenCalledWith(false);

    flushSync(() => {
      root.unmount();
    });
  });

  it("hides the collapse affordance on mobile (drawer handles it)", async () => {
    mockSidebar.isMobile = true;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    expect(container.querySelector('button[aria-label="Collapse sidebar"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Keep sidebar expanded"]')).toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });
});
