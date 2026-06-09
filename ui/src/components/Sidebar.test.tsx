// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  // Mirror react-router's NavLink: className and children both accept a render
  // function receiving { isActive }. SidebarNavItem uses the function-children
  // form, so a literal {children} render would produce empty links. Also strip
  // the `state` prop so it isn't leaked onto the DOM node as an attribute.
  NavLink: ({ to, children, className, state: _state, ...props }: {
    to: string;
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    className?: string | ((state: { isActive: boolean }) => string);
    state?: unknown;
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {typeof children === "function" ? children({ isActive: false }) : children}
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
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "ValadrienOs" },
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
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

vi.mock("./SidebarProjects", () => ({
  SidebarProjects: () => null,
}));

vi.mock("./SidebarAgents", () => ({
  SidebarAgents: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Sidebar", () => {
  let container: HTMLDivElement;

  async function renderSidebar() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
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

    await act(async () => {
      root.unmount();
    });
  });

  it("renders plugin sidebar launchers inside the Work section", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    const workSection = [...container.querySelectorAll("nav [data-plugin-launcher-zone]")]
      .find((node) => node.getAttribute("data-plugin-launcher-zone") === "sidebar");
    expect(workSection?.textContent).toContain("Plugin launcher outlet");
    const workSectionContainer = workSection?.parentElement?.parentElement;
    expect(workSectionContainer?.textContent).toContain("Work");
    expect(workSectionContainer?.textContent).toContain("Issues");
    expect(workSectionContainer?.textContent).toContain("Goals");

    await act(async () => {
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

    await act(async () => {
      root.unmount();
    });
  });

  it("does not flash the Workspaces link while experimental settings are loading", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = await renderSidebar();

    expect(container.textContent).not.toContain("Workspaces");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the Workspaces link when isolated workspaces are enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = await renderSidebar();

    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Workspaces");
    expect(link?.getAttribute("href")).toBe("/workspaces");

    await act(async () => {
      root.unmount();
    });
  });
});
