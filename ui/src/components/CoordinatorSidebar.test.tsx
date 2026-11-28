// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorSidebar } from "./CoordinatorSidebar";
import { TooltipProvider } from "./ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ enableStatusCards: false, enableGoalsSidebarLink: false, isMobile: false, setSidebarOpen: vi.fn() }));

vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: "user", agents: { data: [] }, chats: { data: [] }, session: { isSuccess: true },
}) }));
vi.mock("@/hooks/usePinnedNavigation", () => ({ usePinnedNavigation: () => ({
  pins: [], canPin: false, toggle: vi.fn(), reorder: vi.fn(), error: null,
}) }));
vi.mock("@/hooks/useResponsibilitiesEnabled", () => ({ useResponsibilitiesEnabled: () => ({ enabled: false }) }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: [], pinnedTasks: [] }) }));
vi.mock("@/hooks/useRecentTaskOpenWarmup", () => ({ useRecentTaskOpenWarmup: () => undefined }));
vi.mock("@/hooks/useCoordinatorAttentionCount", () => ({ useCoordinatorAttentionCount: () => 0 }));
vi.mock("@/lib/company-projects-query", () => ({ companyProjectsQuery: (companyId: string) => ({
  queryKey: ["projects", companyId], queryFn: async () => [],
}) }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({
  enableStatusCards: fixture.enableStatusCards, enableGoalsSidebarLink: fixture.enableGoalsSidebarLink,
}) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({
  selectedCompanyId: "company", selectedCompany: { id: "company", issuePrefix: "ACME" },
}) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: fixture.isMobile, setSidebarOpen: fixture.setSidebarOpen }) }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: ({ slotTypes, context, itemClassName }: { slotTypes: string[]; context: Record<string, unknown>; itemClassName?: string }) =>
  <div data-testid="plugin-slot-outlet" data-slot-types={slotTypes.join(",")} data-context={JSON.stringify(context)}><div data-testid="plugin-slot-item" className={itemClassName} /></div> }));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: ({ placementZones, context, itemClassName, onNavigate }: { placementZones: string[]; context: Record<string, unknown>; itemClassName?: string; onNavigate?: () => void }) =>
  <div data-testid="plugin-launcher-outlet" data-placement-zones={placementZones.join(",")} data-context={JSON.stringify(context)}><div data-testid="plugin-launcher-item" className={itemClassName}><button type="button" data-testid="plugin-launcher-navigate" onClick={() => onNavigate?.()} /></div></div> }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/ACME/issues", search: "" }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className, state: _state, end: _end, ...props }: {
    to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string); state?: unknown; end?: boolean;
  }) => <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>,
}));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  fixture.enableStatusCards = false;
  fixture.enableGoalsSidebarLink = false;
  fixture.isMobile = false;
  fixture.setSidebarOpen.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

async function renderSidebar() {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><CoordinatorSidebar /></TooltipProvider></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
const navigation = () => container.querySelector('nav[aria-label="Workspace navigation"]')!;
const pluginContext = { companyId: "company", companyPrefix: "ACME" };

describe("CoordinatorSidebar plugin and flag-gated entries", () => {
  it("renders plugin sidebar pages, launchers and panels with the company plugin context", async () => {
    await renderSidebar();
    const outlets = [...navigation().querySelectorAll('[data-testid="plugin-slot-outlet"]')];
    expect(outlets.map(outlet => outlet.getAttribute("data-slot-types"))).toEqual(["sidebar", "sidebarPanel"]);
    for (const outlet of outlets) expect(JSON.parse(outlet.getAttribute("data-context")!)).toEqual(pluginContext);
    const launchers = navigation().querySelector('[data-testid="plugin-launcher-outlet"]');
    expect(launchers?.getAttribute("data-placement-zones")).toBe("sidebar");
    expect(JSON.parse(launchers!.getAttribute("data-context")!)).toEqual(pluginContext);
  });

  it("insets plugin sidebar rows once, like native rows", async () => {
    await renderSidebar();
    const slotItem = navigation().querySelector('[data-testid="plugin-slot-outlet"][data-slot-types="sidebar"] [data-testid="plugin-slot-item"]')!;
    expect(slotItem.classList.contains("design-sidebar-item")).toBe(false);
    expect(slotItem.classList.contains("design-sidebar-plugin-item")).toBe(true);
    expect([...slotItem.classList].some(name => /^-?(m|p)[xlrse]?-/.test(name))).toBe(false);
    const launcherItem = navigation().querySelector('[data-testid="plugin-launcher-item"]')!;
    expect(launcherItem.classList.contains("design-sidebar-item")).toBe(false);
    expect([...launcherItem.classList].filter(name => /^-?(m|p)[xlrse]?-/.test(name))).toEqual(["mx-2"]);
  });

  it.each([false, true])("shows Status and Goals only when their flags are enabled (%s)", async enabled => {
    fixture.enableStatusCards = enabled;
    fixture.enableGoalsSidebarLink = enabled;
    await renderSidebar();
    expect(navigation().querySelector('a[href="/status"]') !== null).toBe(enabled);
    expect(navigation().querySelector('a[href="/goals"]') !== null).toBe(enabled);
  });

  it.each([true, false])("closes the sidebar when a plugin launcher navigates only on mobile (%s)", async isMobile => {
    fixture.isMobile = isMobile;
    await renderSidebar();
    await act(async () => { navigation().querySelector<HTMLButtonElement>('[data-testid="plugin-launcher-navigate"]')!.click(); });
    expect(fixture.setSidebarOpen.mock.calls).toEqual(isMobile ? [[false]] : []);
  });

  it("controls Status and Goals independently", async () => {
    fixture.enableStatusCards = true;
    await renderSidebar();
    expect(navigation().querySelector('a[href="/status"]')?.textContent).toContain("Status");
    expect(navigation().querySelector('a[href="/goals"]')).toBeNull();
  });
});
