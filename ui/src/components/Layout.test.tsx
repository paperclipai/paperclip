// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "./Layout";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  getExperimental: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockCompanyState = vi.hoisted(() => ({
  companies: [{ id: "company-1", issuePrefix: "PAP", name: "Paperclip" }],
  selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
  selectedCompanyId: "company-1",
}));
const mockPluginSlots = vi.hoisted(() => ({
  slots: [] as Array<Record<string, unknown>>,
}));
const mockUsePluginSlots = vi.hoisted(() => vi.fn());
const mockPluginSlotContexts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const mockSetPeeking = vi.hoisted(() => vi.fn());
const mockSetForceCollapsed = vi.hoisted(() => vi.fn());
const mockSidebarState = vi.hoisted(() => ({
  sidebarOpen: true,
  isMobile: false,
  collapsed: false,
  peeking: false,
}));
let currentPathname = "/PAP/dashboard";

vi.mock("@/lib/router", () => ({
  Outlet: () => <div>Outlet content</div>,
  useLocation: () => ({ pathname: currentPathname, search: "", hash: "", state: null }),
  useNavigate: () => mockNavigate,
  useNavigationType: () => "PUSH",
  useParams: () => {
    const [firstSegment, secondSegment, entityId] = currentPathname.split("/").filter(Boolean);
    return {
      companyPrefix: firstSegment ?? "PAP",
      pluginRoutePath: secondSegment,
      agentId: secondSegment === "agents" ? entityId : undefined,
      routineId: secondSegment === "routines" ? entityId : undefined,
    };
  },
}));

vi.mock("./Sidebar", () => ({
  Sidebar: ({ contentHeaderControls }: { contentHeaderControls?: boolean }) => (
    <div data-content-header-controls={String(contentHeaderControls ?? false)}>Main company nav</div>
  ),
}));

vi.mock("./CompanySettingsSidebar", () => ({
  CompanySettingsSidebar: () => <div>Company settings sidebar</div>,
}));

vi.mock("./AppsSidebar", () => ({
  AppsSidebar: () => <div>Apps sidebar</div>,
}));

vi.mock("./AgentContextualSidebar", () => ({
  AgentContextualSidebar: ({ agentRef }: { agentRef: string }) => <div>Agent sidebar {agentRef}</div>,
}));

vi.mock("./RoutineContextualSidebar", () => ({
  RoutineContextualSidebar: ({ routineId }: { routineId: string }) => <div>Routine sidebar {routineId}</div>,
}));

vi.mock("./SkillsContextualSidebar", () => ({
  SkillsContextualSidebar: () => <div>Skills sidebar</div>,
}));

vi.mock("./AppConnectionSidebar", () => ({
  AppDetailSidebar: (props: { kind: "connection"; connectionId: string } | { kind: "application"; applicationId: string }) => (
    <div>
      {props.kind === "connection"
        ? `App detail sidebar connection ${props.connectionId}`
        : `App detail sidebar application ${props.applicationId}`}
    </div>
  ),
}));

vi.mock("./BreadcrumbBar", () => ({
  BreadcrumbBar: () => <div>Breadcrumbs</div>,
}));

vi.mock("./PropertiesPanel", () => ({
  PropertiesPanel: () => null,
}));

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("./NewIssueDialog", () => ({
  NewIssueDialog: () => null,
}));

vi.mock("./NewProjectDialog", () => ({
  NewProjectDialog: () => null,
}));

vi.mock("./NewGoalDialog", () => ({
  NewGoalDialog: () => null,
}));

vi.mock("./NewAgentDialog", () => ({
  NewAgentDialog: () => null,
}));

vi.mock("./KeyboardShortcutsCheatsheet", () => ({
  KeyboardShortcutsCheatsheet: () => null,
}));

vi.mock("./ToastViewport", () => ({
  ToastViewport: () => null,
}));

vi.mock("./MobileBottomNav", () => ({
  MobileBottomNav: () => null,
}));

vi.mock("./WorktreeBanner", () => ({
  WorktreeBanner: () => null,
}));

vi.mock("./DevRestartBanner", () => ({
  DevRestartBanner: () => null,
}));

vi.mock("./SidebarAccountMenu", () => ({
  SidebarAccountMenu: () => <div>Account menu</div>,
}));

vi.mock("../plugins/slots", async () => {
  const actual = await vi.importActual<typeof import("../plugins/slots")>("../plugins/slots");
  return {
    resolveRouteSidebarSlot: actual.resolveRouteSidebarSlot,
    usePluginSlots: (params: Record<string, unknown>) => {
      mockUsePluginSlots(params);
      return {
        slots: mockPluginSlots.slots,
        isLoading: false,
        errorMessage: null,
      };
    },
    PluginSlotMount: ({
      slot,
      context,
      className,
    }: {
      slot: { displayName: string };
      context: Record<string, unknown>;
      className?: string;
    }) => {
      mockPluginSlotContexts.push(context);
      return <div data-plugin-slot-class={className}>Plugin route sidebar: {slot.displayName}</div>;
    },
  };
});

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
    openOnboarding: vi.fn(),
  }),
  useDialogActions: () => ({
    openNewIssue: vi.fn(),
    openOnboarding: vi.fn(),
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    togglePanelVisible: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: mockCompanyState.companies,
    loading: false,
    selectedCompany: mockCompanyState.selectedCompany,
    selectedCompanyId: mockCompanyState.selectedCompanyId,
    selectionSource: "manual",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    sidebarOpen: mockSidebarState.sidebarOpen,
    setSidebarOpen: mockSetSidebarOpen,
    toggleSidebar: vi.fn(),
    toggleCollapsed: vi.fn(),
    collapsed: mockSidebarState.collapsed,
    peeking: mockSidebarState.peeking,
    setPeeking: mockSetPeeking,
    setForceCollapsed: mockSetForceCollapsed,
    isMobile: mockSidebarState.isMobile,
    routeRequestsCollapsed: false,
    setRouteRequestsCollapsed: vi.fn(),
  }),
}));

vi.mock("../hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: () => undefined,
}));

vi.mock("../hooks/useCompanyPageMemory", () => ({
  useCompanyPageMemory: () => undefined,
}));

vi.mock("../api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../lib/company-selection", () => ({
  shouldSyncCompanySelectionFromRoute: () => false,
  // No bounce in the shared harness: these tests exercise layout chrome, not
  // archived-company routing (covered by company-selection unit tests and the
  // archived-company-url e2e).
  resolveArchivedCompanyBounce: () => null,
}));

vi.mock("../lib/main-content-focus", () => ({
  scheduleMainContentFocus: () => () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Layout", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentPathname = "/PAP/dashboard";
    mockCompanyState.companies = [{ id: "company-1", issuePrefix: "PAP", name: "Paperclip" }];
    mockCompanyState.selectedCompany = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    mockCompanyState.selectedCompanyId = "company-1";
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      version: "1.2.3",
    });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      keyboardShortcuts: false,
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableApps: true });
    mockPluginSlots.slots = [];
    mockPluginSlotContexts.length = 0;
    mockSidebarState.sidebarOpen = true;
    mockSidebarState.isMobile = false;
    mockSidebarState.collapsed = false;
    mockSidebarState.peeking = false;
    mockSetPeeking.mockClear();
    mockSetForceCollapsed.mockClear();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does not render the deployment explainer in the shared layout", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockHealthApi.get).toHaveBeenCalled();
    expect(container.textContent).toContain("Breadcrumbs");
    expect(container.textContent).toContain("Outlet content");
    expect(container.textContent).not.toContain("Company rail");
    expect(container.textContent).not.toContain("Authenticated private");
    expect(container.textContent).not.toContain(
      "Sign-in is required and this instance is intended for private-network access.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("scopes the Streamlined task-detail surface while preserving balanced horizontal gutters", async () => {
    currentPathname = "/PAP/issues/PAP-1";
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableApps: true,
      enableStreamlinedUi: true,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector(".streamlined-task-detail-surface")).not.toBeNull();
    expect(container.querySelector("#main-content")?.classList.contains("pt-0")).toBe(true);
    expect(container.querySelector("#main-content")?.classList.contains("md:pt-0")).toBe(true);
    expect(container.querySelector("#main-content")?.classList.contains("p-4")).toBe(true);
    expect(container.querySelector("#main-content")?.classList.contains("md:p-6")).toBe(true);
    expect(container.querySelector("#main-content")?.classList.contains("pr-0")).toBe(false);
    expect(container.querySelector("#main-content")?.classList.contains("md:pr-0")).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("collapses atomically when the pointer is still over the sidebar (no re-peek) — PAP-10676", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const renderLayout = async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Layout />
          </QueryClientProvider>,
        );
      });
      await flushReact();
    };

    // The SidebarShell overlay panel carries the peek mouse handlers.
    const panel = () =>
      [...container.querySelectorAll<HTMLElement>("div")].find(
        (el) => el.className.includes("inset-y-0") && el.className.includes("overflow-hidden"),
      );
    const hover = (el: HTMLElement) => {
      // React derives onMouseEnter from a mouseover crossing in from outside.
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    };

    // Expanded, then hover the panel so the pointer is registered as inside.
    await renderLayout();
    const expandedPanel = panel();
    expect(expandedPanel).toBeTruthy();
    await act(async () => { hover(expandedPanel!); });

    // Collapse while the pointer is still over the panel.
    mockSidebarState.collapsed = true;
    await renderLayout();
    // The peek is cancelled atomically on collapse.
    expect(mockSetPeeking).toHaveBeenCalledWith(false);

    // A lingering/spurious hover while collapsed must NOT re-open the peek.
    mockSetPeeking.mockClear();
    const railPanel = panel();
    await act(async () => { hover(railPanel!); });
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(mockSetPeeking).not.toHaveBeenCalledWith(true);

    await act(async () => { root.unmount(); });
  });

  it("opens the peek when hovering a collapsed rail (positive control for the hover sim)", async () => {
    mockSidebarState.collapsed = true;
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const panel = [...container.querySelectorAll<HTMLElement>("div")].find(
      (el) => el.className.includes("inset-y-0") && el.className.includes("overflow-hidden"),
    );
    expect(panel).toBeTruthy();
    await act(async () => {
      panel!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    // A normal collapsed-rail hover (not just-collapsed) opens the peek.
    expect(mockSetPeeking).toHaveBeenCalledWith(true);

    await act(async () => { root.unmount(); });
  });

  it("replaces the app sidebar with settings navigation on Streamlined settings routes", async () => {
    currentPathname = "/PAP/company/settings/access";
    mockPluginSlots.slots = [
      {
        type: "page",
        id: "company-page",
        displayName: "Company Page",
        exportName: "CompanyPage",
        routePath: "company",
        pluginId: "plugin-1",
        pluginKey: "fake-plugin",
        pluginDisplayName: "Fake Plugin",
        pluginVersion: "1.0.0",
      },
      {
        type: "routeSidebar",
        id: "company-sidebar",
        displayName: "Company Route Sidebar",
        exportName: "CompanySidebar",
        routePath: "company",
        pluginId: "plugin-1",
        pluginKey: "fake-plugin",
        pluginDisplayName: "Fake Plugin",
        pluginVersion: "1.0.0",
      },
    ];
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Company settings sidebar");
    expect(container.textContent).not.toContain("Main company nav");
    const secondaryRail = container.querySelector("[data-secondary-sidebar]");
    expect(secondaryRail).not.toBeNull();
    expect(secondaryRail?.classList.contains("w-60")).toBe(false);
    expect(container.textContent).not.toContain("Company rail");
    expect(container.textContent).not.toContain("Instance sidebar");
    expect(container.textContent).not.toContain("Plugin route sidebar");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the global sidebar beside legacy settings navigation when Streamlined UI is off", async () => {
    currentPathname = "/PAP/company/settings/access";
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableApps: true,
      enableStreamlinedUi: false,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Main company nav");
    expect(container.textContent).toContain("Company settings sidebar");
    expect(mockSetForceCollapsed).toHaveBeenCalledWith(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders a mobile company settings selector on company settings routes", async () => {
    currentPathname = "/PAP/company/settings/secrets";
    mockSidebarState.isMobile = true;
    mockSidebarState.sidebarOpen = false;
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const selector = container.querySelector("select");
    expect(selector).not.toBeNull();
    expect(selector?.value).toBe("secrets");
    const selectorText = selector?.textContent?.toLowerCase() ?? "";
    expect(selectorText).toContain("general");
    expect(selectorText).toContain("export");
    expect(selectorText).toContain("import");
    expect(selectorText).toContain("members");
    // Invites live on a tab of the Members page now, so the selector no
    // longer carries a standalone entry for them.
    expect(selectorText).not.toContain("invites");
    expect(selectorText).toContain("secrets");
    expect(selectorText).toContain("profile");
    expect(selectorText).toContain("environments");
    expect(selectorText).toContain("plugins");
    expect(selectorText).not.toContain("instance general");

    await act(async () => {
      root.unmount();
    });
  });

  it("replaces the company nav on instance settings routes", async () => {
    currentPathname = "/PAP/company/settings/instance/general";
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Company settings sidebar");
    expect(container.textContent).not.toContain("Main company nav");
    expect(container.textContent).not.toContain("Company rail");
    expect(container.textContent).not.toContain("Plugin route sidebar");

    await act(async () => {
      root.unmount();
    });
  });

  it.each(["/PAP/company/export", "/PAP/company/import"])(
    "replaces the company nav with the shared settings sidebar on %s",
    async (pathname) => {
      currentPathname = pathname;
      const root = createRoot(container);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Layout />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();

      expect(container.textContent).toContain("Company settings sidebar");
      expect(container.textContent).not.toContain("Main company nav");

      await act(async () => {
        root.unmount();
      });
    },
  );

  it("keeps the company nav beside Apps navigation on legacy tools routes", async () => {
    currentPathname = "/PAP/tools/runtime";
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Apps sidebar");
    expect(container.textContent).toContain("Main company nav");
    expect(container.textContent).not.toContain("Company settings sidebar");

    await act(async () => {
      root.unmount();
    });
  });

  it("mounts the Apps secondary sidebar regardless of the retired experimental flag", async () => {
    currentPathname = "/PAP/apps";
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableApps: false });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Apps sidebar");
    expect(container.textContent).toContain("Main company nav");
    const secondaryRail = container.querySelector("[data-secondary-sidebar]");
    expect(secondaryRail?.classList.contains("w-60")).toBe(true);
    expect(secondaryRail?.classList.contains("shrink-0")).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the Apps sidebar on the M8 advanced-setup tabs", async () => {
    currentPathname = "/PAP/apps/advanced/paste-config";
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Apps sidebar");
    expect(container.textContent).toContain("Main company nav");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the Apps sidebar on legacy developer tabs behind the Advanced door", async () => {
    currentPathname = "/PAP/apps/advanced/runtime";
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Apps sidebar");
    expect(container.textContent).toContain("Main company nav");

    await act(async () => {
      root.unmount();
    });
  });

  // Reserved Apps subroutes are not connection ids. They must keep the
  // top-level Apps sidebar, never mount a detail sidebar for a phantom app.
  it.each(["browse", "connections", "vercel-connect", "review"])("keeps the Apps sidebar on the %s surface", async (route) => {
    currentPathname = `/PAP/apps/${route}`;
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Apps sidebar");
    expect(container.textContent).toContain("Main company nav");
    expect(container.textContent).not.toContain("App detail sidebar");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the Apps sidebar on the gateways list and detail routes", async () => {
    for (const pathname of ["/PAP/apps/gateways", "/PAP/apps/gateways/gw-1/overview"]) {
      currentPathname = pathname;
      const root = createRoot(container);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Layout />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();

      expect(container.textContent).toContain("Apps sidebar");
      expect(container.textContent).toContain("Main company nav");
      expect(container.textContent).not.toContain("App detail sidebar");

      await act(async () => {
        root.unmount();
      });
    }
  });

  it("uses the app connection sidebar on app detail routes", async () => {
    currentPathname = "/PAP/apps/conn-1/permissions";
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("App detail sidebar connection conn-1");
    expect(container.textContent).toContain("Main company nav");
    expect(container.textContent).not.toContain("Apps sidebar");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses the app detail sidebar on not-connected app routes", async () => {
    currentPathname = "/PAP/apps/app/app-1/permissions";
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("App detail sidebar application app-1");
    expect(container.textContent).toContain("Main company nav");
    expect(container.textContent).not.toContain("Apps sidebar");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps global navigation beside Skills, Agent, and Routine details", async () => {
    async function renderAt(pathname: string) {
      currentPathname = pathname;
      const root = createRoot(container);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Layout />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();
      return root;
    }

    for (const [pathname, sidebarText] of [
      ["/PAP/skills/studio", "Skills sidebar"],
      ["/PAP/agents/briefing-analyst/skills", "Agent sidebar briefing-analyst"],
      ["/PAP/agents/briefing-analyst/runs/run-1", "Agent sidebar briefing-analyst"],
      ["/PAP/routines/routine-1/overview", "Routine sidebar routine-1"],
    ] as const) {
      const root = await renderAt(pathname);
      expect(container.textContent).toContain(sidebarText);
      expect(container.textContent).toContain("Main company nav");
      const secondaryRail = container.querySelector("[data-secondary-sidebar]");
      expect(secondaryRail?.classList.contains("w-60")).toBe(true);
      expect(secondaryRail?.classList.contains("bg-background")).toBe(true);
      const breadcrumb = Array.from(container.querySelectorAll("div"))
        .find((element) => element.textContent === "Breadcrumbs");
      expect(breadcrumb).toBeDefined();
      expect(
        breadcrumb && secondaryRail
          ? breadcrumb.compareDocumentPosition(secondaryRail) & Node.DOCUMENT_POSITION_FOLLOWING
          : 0,
      ).not.toBe(0);
      await act(async () => {
        root.unmount();
      });
      container.innerHTML = "";
    }
  });

  it("keeps global navigation on legacy Agent and Routine detail routes", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableApps: true,
      enableStreamlinedUi: false,
    });

    for (const pathname of [
      "/PAP/agents/briefing-analyst/skills",
      "/PAP/routines/routine-1/overview",
    ]) {
      currentPathname = pathname;
      const root = createRoot(container);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Layout />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();

      expect(container.textContent).toContain("Main company nav");
      expect(container.textContent).not.toContain("Agent sidebar");
      expect(container.textContent).not.toContain("Routine sidebar");

      await act(async () => {
        root.unmount();
      });
      container.innerHTML = "";
    }
  });

  it("keeps the global rail beside Skills navigation in the legacy shell", async () => {
    currentPathname = "/PAP/skills/studio";
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableApps: true,
      enableStreamlinedUi: false,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Main company nav");
    expect(container.textContent).toContain("Skills sidebar");
    expect(mockSetForceCollapsed).toHaveBeenCalledWith(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps Agent and Routine collection routes in global navigation", async () => {
    for (const pathname of ["/PAP/agents/all", "/PAP/agents/new", "/PAP/routines"]) {
      currentPathname = pathname;
      const root = createRoot(container);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Layout />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();

      expect(container.textContent).toContain("Main company nav");
      expect(container.textContent).not.toContain("Agent sidebar");
      expect(container.textContent).not.toContain("Routine sidebar");

      await act(async () => {
        root.unmount();
      });
      container.innerHTML = "";
    }
  });

  it("renders a route-scoped plugin sidebar for a matching plugin page route", async () => {
    currentPathname = "/PAP/wiki";
    mockPluginSlots.slots = [
      {
        type: "page",
        id: "wiki-page",
        displayName: "Wiki Page",
        exportName: "WikiPage",
        routePath: "wiki",
        pluginId: "plugin-1",
        pluginKey: "wiki-plugin",
        pluginDisplayName: "Wiki Plugin",
        pluginVersion: "1.0.0",
      },
      {
        type: "routeSidebar",
        id: "wiki-route-sidebar",
        displayName: "Wiki Sidebar",
        exportName: "WikiSidebar",
        routePath: "wiki",
        pluginId: "plugin-1",
        pluginKey: "wiki-plugin",
        pluginDisplayName: "Wiki Plugin",
        pluginVersion: "1.0.0",
      },
    ];
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Plugin route sidebar: Wiki Sidebar");
    expect(container.querySelector("[data-plugin-slot-class='min-h-0 flex-1']")).not.toBeNull();
    expect(container.textContent).not.toContain("Main company nav");
    expect(container.textContent).not.toContain("Company settings sidebar");
    expect(container.textContent).not.toContain("Instance sidebar");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the route-scoped plugin sidebar on nested plugin page routes", async () => {
    currentPathname = "/PAP/wiki/page/templates";
    mockPluginSlots.slots = [
      {
        type: "page",
        id: "wiki-page",
        displayName: "Wiki Page",
        exportName: "WikiPage",
        routePath: "wiki",
        pluginId: "plugin-1",
        pluginKey: "wiki-plugin",
        pluginDisplayName: "Wiki Plugin",
        pluginVersion: "1.0.0",
      },
      {
        type: "routeSidebar",
        id: "wiki-route-sidebar",
        displayName: "Wiki Sidebar",
        exportName: "WikiSidebar",
        routePath: "wiki",
        pluginId: "plugin-1",
        pluginKey: "wiki-plugin",
        pluginDisplayName: "Wiki Plugin",
        pluginVersion: "1.0.0",
      },
    ];
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockUsePluginSlots).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        enabled: true,
      }),
    );
    expect(container.textContent).toContain("Plugin route sidebar: Wiki Sidebar");
    expect(container.textContent).not.toContain("Main company nav");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses the route company context for plugin route sidebars on the first render", async () => {
    currentPathname = "/ALT/wiki";
    mockCompanyState.companies = [
      { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
      { id: "company-2", issuePrefix: "ALT", name: "Alternate" },
    ];
    mockCompanyState.selectedCompany = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    mockCompanyState.selectedCompanyId = "company-1";
    mockPluginSlots.slots = [
      {
        type: "page",
        id: "wiki-page",
        displayName: "Wiki Page",
        exportName: "WikiPage",
        routePath: "wiki",
        pluginId: "plugin-1",
        pluginKey: "wiki-plugin",
        pluginDisplayName: "Wiki Plugin",
        pluginVersion: "1.0.0",
      },
      {
        type: "routeSidebar",
        id: "wiki-route-sidebar",
        displayName: "Wiki Sidebar",
        exportName: "WikiSidebar",
        routePath: "wiki",
        pluginId: "plugin-1",
        pluginKey: "wiki-plugin",
        pluginDisplayName: "Wiki Plugin",
        pluginVersion: "1.0.0",
      },
    ];
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockUsePluginSlots).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-2",
        enabled: true,
      }),
    );
    expect(mockPluginSlotContexts).toContainEqual({
      companyId: "company-2",
      companyPrefix: "ALT",
    });
    expect(mockPluginSlotContexts).not.toContainEqual({
      companyId: "company-1",
      companyPrefix: "PAP",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the normal company sidebar when a plugin page route is ambiguous", async () => {
    currentPathname = "/PAP/wiki";
    mockPluginSlots.slots = [
      {
        type: "page",
        id: "wiki-page-a",
        displayName: "Wiki Page A",
        exportName: "WikiPageA",
        routePath: "wiki",
        pluginId: "plugin-1",
        pluginKey: "wiki-plugin-a",
        pluginDisplayName: "Wiki Plugin A",
        pluginVersion: "1.0.0",
      },
      {
        type: "page",
        id: "wiki-page-b",
        displayName: "Wiki Page B",
        exportName: "WikiPageB",
        routePath: "wiki",
        pluginId: "plugin-2",
        pluginKey: "wiki-plugin-b",
        pluginDisplayName: "Wiki Plugin B",
        pluginVersion: "1.0.0",
      },
      {
        type: "routeSidebar",
        id: "wiki-route-sidebar",
        displayName: "Wiki Sidebar",
        exportName: "WikiSidebar",
        routePath: "wiki",
        pluginId: "plugin-1",
        pluginKey: "wiki-plugin-a",
        pluginDisplayName: "Wiki Plugin A",
        pluginVersion: "1.0.0",
      },
    ];
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Main company nav");
    expect(container.textContent).not.toContain("Plugin route sidebar");

    await act(async () => {
      root.unmount();
    });
  });

  async function renderLayoutRoot(): Promise<{ root: ReturnType<typeof createRoot>; rootEl: HTMLElement }> {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    const rootEl = container.firstElementChild as HTMLElement;
    return { root, rootEl };
  }

  it("clips horizontal overflow on the mobile layout root so the viewport can't scroll sideways", async () => {
    mockSidebarState.isMobile = true;
    mockSidebarState.sidebarOpen = false;
    const { root, rootEl } = await renderLayoutRoot();

    expect(rootEl.tagName).toBe("DIV");
    expect(rootEl.className).toContain("bg-background");
    // The mobile root must clip horizontal overflow to prevent a stray wide
    // descendant from making the whole viewport scroll sideways. clip (not
    // hidden) keeps overflow-y visible so body scroll keeps working.
    expect(rootEl.classList.contains("overflow-x-clip")).toBe(true);
    expect(rootEl.classList.contains("overflow-hidden")).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("clips overflow on the desktop layout root", async () => {
    mockSidebarState.isMobile = false;
    const { root, rootEl } = await renderLayoutRoot();

    expect(rootEl.className).toContain("bg-background");
    expect(rootEl.classList.contains("overflow-clip")).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
