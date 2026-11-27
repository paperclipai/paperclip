// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "./Layout";
import { queryKeys } from "@/lib/queryKeys";

const mockSidebarState = {
  sidebarOpen: true,
  setSidebarOpen: vi.fn(),
  toggleSidebar: vi.fn(),
  isMobile: true,
};

const mockUsePluginSlots = vi.fn();

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockSidebarState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" }],
    loading: false,
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" },
    selectedCompanyId: "company-1",
    selectionSource: "manual",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn(), openOnboarding: vi.fn() }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    panelContent: null,
    panelVisible: false,
    panelShowsArtifact: false,
    togglePanelVisible: vi.fn(),
    setPanelVisible: vi.fn(),
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useOptionalToastActions: () => null,
}));

vi.mock("@/context/DesignSandboxContext", () => ({
  useDesignSandbox: () => false,
}));

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: false, userId: "user-1" }),
}));

vi.mock("@/hooks/useBrowserTimeZoneSync", () => ({
  useBrowserTimeZoneSync: () => {},
}));

vi.mock("../hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({ enabled: true }),
}));

vi.mock("../hooks/useCompanyPageMemory", () => ({
  useCompanyPageMemory: () => {},
}));

vi.mock("../hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: () => {},
}));

vi.mock("../hooks/useMobileNavVisibility", () => ({
  useMobileNavVisibility: () => true,
}));

vi.mock("../hooks/useMobileVisualViewport", () => ({
  useMobileVisualViewport: () => ({ current: null }),
}));

vi.mock("../hooks/useAgentChatEnabled", () => ({
  useAgentChatEnabled: () => ({ enabled: true }),
}));

vi.mock("../plugins/slots", () => ({
  PluginSlotMount: () => <div data-testid="plugin-sidebar-slot">Plugin Sidebar</div>,
  resolveRouteSidebarSlot: (slots: Array<{ id: string; displayName: string }>) => slots[0] ?? null,
  usePluginSlots: (...args: unknown[]) => mockUsePluginSlots(...args),
}));

vi.mock("./Sidebar", () => ({
  Sidebar: () => <nav data-testid="global-workspace-sidebar">Global Workspace Sidebar</nav>,
}));

vi.mock("./AgentContextualSidebar", () => ({
  AgentContextualSidebar: ({ agentRef }: { agentRef: string }) => (
    <div data-testid="agent-contextual-sidebar">Agent Sidebar: {agentRef}</div>
  ),
  AgentContextualMobileNav: ({ agentRef }: { agentRef: string }) => (
    <nav data-testid="agent-contextual-mobile-nav">Agent Mobile Tabs: {agentRef}</nav>
  ),
}));

vi.mock("./CompanySettingsSidebar", () => ({
  CompanySettingsSidebar: () => <div data-testid="settings-sidebar">Settings Sidebar</div>,
}));

vi.mock("./access/CompanySettingsNav", () => ({
  CompanySettingsNav: () => <div data-testid="settings-mobile-nav">Settings Mobile Nav</div>,
}));

vi.mock("./AppsSidebar", () => ({
  AppsSidebar: () => <div data-testid="apps-sidebar">Apps Sidebar</div>,
  AppsMobileNav: () => <div data-testid="apps-mobile-nav">Apps Mobile Nav</div>,
  appsRouteHasMobileNav: (pathname: string, hasDeveloperTabs: boolean) => {
    if (pathname.replace(/\/+$/, "").endsWith("/apps/chat/connect")) return false;
    if (/\/apps\/chat\/([^/]+)(?:\/(?:settings|access|conversations|activity)|\/reviews(?:\/[^/]+)?)?\/?$/.test(pathname)) {
      return true;
    }
    return hasDeveloperTabs;
  },
  useAppsDeveloperTabs: () => [],
}));

vi.mock("./AppConnectionSidebar", () => ({
  AppDetailSidebar: () => <div data-testid="app-detail-sidebar">App Detail Sidebar</div>,
  AppDetailMobileNav: () => <div data-testid="app-detail-mobile-nav">App Detail Mobile Nav</div>,
}));

vi.mock("./AgentConversationsSidebar", () => ({
  AgentConversationsSidebar: ({ mobileSwitcher }: { mobileSwitcher?: boolean }) => (
    <div data-testid={mobileSwitcher ? "agent-chat-mobile-switcher" : "agent-chat-sidebar"}>
      {mobileSwitcher ? "Chat Switcher" : "Chat Sidebar"}
    </div>
  ),
}));

vi.mock("./MobileBottomNav", () => ({
  MobileBottomNav: ({ visible }: { visible: boolean }) => (
    <nav data-testid="mobile-bottom-nav" data-visible={String(visible)}>
      Bottom Nav
    </nav>
  ),
}));

vi.mock("./BreadcrumbBar", () => ({
  BreadcrumbBar: () => <div data-testid="breadcrumb-bar">Breadcrumb</div>,
}));

vi.mock("./PropertiesPanel", () => ({ PropertiesPanel: () => null }));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./KeyboardShortcutsCheatsheet", () => ({ KeyboardShortcutsCheatsheet: () => null }));
vi.mock("./ToastViewport", () => ({ ToastViewport: () => null }));
vi.mock("./AnnouncementWell", () => ({ AnnouncementWell: () => null }));
vi.mock("./PluginAppShellOverlays", () => ({ PluginAppShellOverlays: () => null }));
vi.mock("./WorktreeBanner", () => ({ WorktreeBanner: () => null }));
vi.mock("./DevRestartBanner", () => ({ DevRestartBanner: () => null }));
vi.mock("./StandaloneBrowserControls", () => ({ StandaloneBrowserControls: () => null }));
vi.mock("./SidebarAccountMenu", () => ({ SidebarAccountMenu: () => <div data-testid="account-menu" /> }));
vi.mock("./BoardDialogs", () => ({ BoardDialogs: () => null }));
vi.mock("./CloudTrialGate", () => ({ CloudTrialGate: () => null }));

describe("Layout mobile drawer & contextual navigation", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSidebarState.sidebarOpen = true;
    mockSidebarState.isMobile = true;
    mockUsePluginSlots.mockReturnValue({ slots: [] });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  function renderAt(path: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "local_trusted" });
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/:companyPrefix" element={<Layout />}>
                <Route path="agents/:agentId/:tab" element={<div>Agent Page</div>} />
                <Route path="apps/chat/connect" element={<div>Chat Connect Page</div>} />
                <Route path="custom-plugin" element={<div>Plugin Page</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
  }

  it("renders inline mobile tabs on Agent Detail, opens drawer to global Workspace nav, and layers drawer backdrop above hidden MobileBottomNav", () => {
    renderAt("/PAP/agents/codexcoder/overview");

    expect(container.querySelector('[data-testid="agent-contextual-mobile-nav"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="global-workspace-sidebar"]')).not.toBeNull();

    const switcher = container.querySelector('[data-slot="mobile-drawer-switcher"]');
    expect(switcher).not.toBeNull();
    const buttons = Array.from(switcher!.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Workspace", "Agent"]);

    flushSync(() => {
      buttons[1]!.click();
    });
    expect(container.querySelector('[data-testid="agent-contextual-sidebar"]')).not.toBeNull();

    flushSync(() => {
      buttons[0]!.click();
    });
    expect(container.querySelector('[data-testid="global-workspace-sidebar"]')).not.toBeNull();

    const bottomNav = container.querySelector('[data-testid="mobile-bottom-nav"]');
    const backdrop = container.querySelector('[data-slot="mobile-drawer-backdrop"]');
    const drawer = container.querySelector('[data-mobile-drawer="true"]');
    expect(bottomNav?.getAttribute("data-visible")).toBe("false");
    expect(backdrop).not.toBeNull();
    expect(drawer).not.toBeNull();
    expect(Boolean(bottomNav!.compareDocumentPosition(backdrop!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(backdrop!.compareDocumentPosition(drawer!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("never traps mobile drawer on plugin routeSidebar routes without inline nav: provides Workspace escape button", () => {
    mockUsePluginSlots.mockReturnValue({
      slots: [{ id: "custom-sidebar", displayName: "Wiki" }],
    });
    renderAt("/PAP/custom-plugin");

    expect(container.querySelector('[data-testid="plugin-sidebar-slot"]')).not.toBeNull();

    const workspaceBtn = Array.from(
      container.querySelectorAll('[data-slot="mobile-drawer-switcher"] button'),
    ).find((b) => b.textContent?.includes("Workspace")) as HTMLButtonElement;
    expect(workspaceBtn).toBeDefined();

    flushSync(() => {
      workspaceBtn.click();
    });
    expect(container.querySelector('[data-testid="global-workspace-sidebar"]')).not.toBeNull();
  });

  it("opens the mobile drawer to the contextual setup sidebar on /apps/chat/connect where no inline bar is rendered", () => {
    renderAt("/PAP/apps/chat/connect?provider=slack");

    expect(container.querySelector('[data-testid="apps-mobile-nav"]')).toBeNull();
    expect(container.querySelector('[data-testid="apps-sidebar"]')).not.toBeNull();

    const workspaceBtn = Array.from(
      container.querySelectorAll('[data-slot="mobile-drawer-switcher"] button'),
    ).find((b) => b.textContent?.includes("Workspace")) as HTMLButtonElement;
    expect(workspaceBtn).toBeDefined();

    flushSync(() => {
      workspaceBtn.click();
    });
    expect(container.querySelector('[data-testid="global-workspace-sidebar"]')).not.toBeNull();
  });
});
