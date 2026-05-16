// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "./Layout";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
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
let currentPathname = "/PAP/dashboard";

vi.mock("@/lib/router", () => ({
  Outlet: () => <div>Outlet content</div>,
  useLocation: () => ({ pathname: currentPathname, search: "", hash: "", state: null }),
  useNavigate: () => mockNavigate,
  useNavigationType: () => "PUSH",
  useParams: () => {
    const firstSegment = currentPathname.split("/").filter(Boolean)[0];
    return { companyPrefix: firstSegment === "instance" ? undefined : firstSegment ?? "PAP" };
  },
}));

vi.mock("./Sidebar", () => ({
  Sidebar: () => <div>Main company nav</div>,
}));

vi.mock("./InstanceSidebar", () => ({
  InstanceSidebar: () => <div>Instance sidebar</div>,
}));

vi.mock("./CompanySettingsSidebar", () => ({
  CompanySettingsSidebar: () => <div>Company settings sidebar</div>,
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
    sidebarOpen: true,
    setSidebarOpen: mockSetSidebarOpen,
    toggleSidebar: vi.fn(),
    isMobile: false,
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
}));

vi.mock("../lib/instance-settings", () => ({
  DEFAULT_INSTANCE_SETTINGS_PATH: "/instance/settings/general",
  normalizeRememberedInstanceSettingsPath: (value: string | null | undefined) =>
    value ?? "/instance/settings/general",
}));

vi.mock("../lib/main-content-focus", () => ({
  scheduleMainContentFocus: () => () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
    mockPluginSlots.slots = [];
    mockPluginSlotContexts.length = 0;
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

  it("renders the company settings sidebar on company settings routes", async () => {
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
    expect(container.textContent).not.toContain("Company rail");
    expect(container.textContent).not.toContain("Instance sidebar");
    expect(container.textContent).not.toContain("Main company nav");
    expect(container.textContent).not.toContain("Plugin route sidebar");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the instance settings sidebar on instance settings routes", async () => {
    currentPathname = "/instance/settings/general";
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

    expect(container.textContent).toContain("Instance sidebar");
    expect(container.textContent).not.toContain("Company rail");
    expect(container.textContent).not.toContain("Company settings sidebar");
    expect(container.textContent).not.toContain("Main company nav");
    expect(container.textContent).not.toContain("Plugin route sidebar");

    await act(async () => {
      root.unmount();
    });
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
    expect(container.querySelector("[data-plugin-slot-class='h-full w-full']")).not.toBeNull();
    expect(container.textContent).not.toContain("Main company nav");
    expect(container.textContent).not.toContain("Company settings sidebar");
    expect(container.textContent).not.toContain("Instance sidebar");

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
});
