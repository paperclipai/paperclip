// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Layout } from "./Layout";
import { Layout as ProductionLayout } from "./Layout.production";

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: false, loaded: true }) }));
vi.mock("@/context/DesignSandboxContext", () => ({ useDesignSandbox: () => false }));
vi.mock("@/lib/router", () => ({
  Outlet: () => <div data-task-chat-shell="" />,
  useLocation: () => ({ pathname: "/PAP/issues/PAP-1", search: "", hash: "", state: null }),
  useNavigate: () => vi.fn(), useNavigationType: () => "PUSH", useParams: () => ({ companyPrefix: "PAP" }),
}));
vi.mock("./Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./Sidebar.production", () => ({ Sidebar: () => null }));
vi.mock("./BreadcrumbBar", () => ({ BreadcrumbBar: () => null }));
vi.mock("./BreadcrumbBar.production", () => ({ BreadcrumbBar: () => null }));
vi.mock("./PropertiesPanel", () => ({ PropertiesPanel: () => null }));
vi.mock("./PluginAppShellOverlays", () => ({ PluginAppShellOverlays: () => null }));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./BoardDialogs", () => ({ BoardDialogs: () => null }));
vi.mock("./KeyboardShortcutsCheatsheet", () => ({ KeyboardShortcutsCheatsheet: () => null }));
vi.mock("./ToastViewport", () => ({ ToastViewport: () => null }));
vi.mock("./AnnouncementWell", () => ({ AnnouncementWell: () => null }));
vi.mock("./MobileBottomNav", () => ({ MobileBottomNav: () => null }));
vi.mock("./WorktreeBanner", () => ({ WorktreeBanner: () => null }));
vi.mock("./DevRestartBanner", () => ({ DevRestartBanner: () => null }));
vi.mock("./SidebarAccountMenu", () => ({ SidebarAccountMenu: () => null }));
vi.mock("./SidebarAccountMenu.production", () => ({ SidebarAccountMenu: () => null }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn(), openOnboarding: vi.fn() }) }));
vi.mock("../context/PanelContext", () => ({ usePanel: () => ({ togglePanelVisible: vi.fn(), setPanelVisible: vi.fn() }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({
  companies: [{ id: "company-1", issuePrefix: "PAP" }], selectedCompany: { id: "company-1", issuePrefix: "PAP" },
  selectedCompanyId: "company-1", loading: false, setSelectedCompanyId: vi.fn(),
}) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({
  isMobile: false, sidebarOpen: true, collapsed: false, peeking: false,
  setSidebarOpen: vi.fn(), setPeeking: vi.fn(), setForceCollapsed: vi.fn(), setRouteRequestsCollapsed: vi.fn(),
}) }));
vi.mock("../hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: () => undefined }));
vi.mock("../hooks/useCompanyPageMemory", () => ({ useCompanyPageMemory: () => undefined }));
vi.mock("../api/health", () => ({ healthApi: { get: async () => ({ status: "ok" }) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getGeneral: async () => ({}), getExperimental: async () => ({}) } }));
vi.mock("../lib/company-selection", () => ({ shouldSyncCompanySelectionFromRoute: () => false, resolveArchivedCompanyBounce: () => null }));
vi.mock("../lib/main-content-focus", () => ({ scheduleMainContentFocus: () => () => undefined }));
vi.mock("../plugins/slots", () => ({ usePluginSlots: () => ({ slots: [] }), resolveRouteSidebarSlot: () => null, PluginSlotMount: () => null }));

it.each([["standard", Layout], ["production", ProductionLayout]] as const)("sizes desktop-width conversations above the keyboard in %s", async (_, Shell) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const viewport = Object.assign(new EventTarget(), { height: 1024, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerWidth", 1366);
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 1024 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><Shell /></QueryClientProvider>));
    const shell = container.querySelector<HTMLElement>(".paperclip-app-shell")!;
    const conversation = shell.querySelector<HTMLElement>("[data-task-chat-shell]")!;
    await act(async () => { viewport.height = 600; viewport.dispatchEvent(new Event("resize")); });
    expect(shell.dataset.mobile).toBeUndefined();
    expect(shell.dataset.keyboardOpen).toBe("true");
    expect(shell.style.getPropertyValue("--mobile-chat-viewport-height")).toBe("600px");
    const stylesheet = readFileSync(resolve("ui/src/index.css"), "utf8");
    const sizingRule = stylesheet.match(/([^{}]+)\{[^{}]*height: var\(--mobile-chat-viewport-height\);[^{}]*\}/)!;
    expect(shell.matches(sizingRule[1].trim())).toBe(true);
    conversation.remove();
    expect(shell.matches(sizingRule[1].trim())).toBe(false);
    shell.append(conversation);
    await act(async () => { viewport.scale = 2; viewport.height = 300; viewport.dispatchEvent(new Event("resize")); });
    expect(shell.style.getPropertyValue("--mobile-chat-viewport-height")).toBe("600px");
    await act(async () => { viewport.scale = 1; viewport.height = 1024; viewport.dispatchEvent(new Event("resize")); });
    expect(shell.dataset.keyboardOpen).toBeUndefined();
    expect(shell.matches(sizingRule[1].trim())).toBe(false);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    Reflect.deleteProperty(document.documentElement, "clientHeight");
    vi.unstubAllGlobals();
  }
});
