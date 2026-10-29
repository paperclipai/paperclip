// @vitest-environment jsdom
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginOrganizationSwitcherProps } from "@paperclipai/plugin-sdk/ui";
import { PluginOrganizationSwitcher } from "./PluginOrganizationSwitcher";
import { registerPluginReactComponent, registerPluginWebComponent, type ResolvedPluginSlot } from "@/plugins/slots";

const state = vi.hoisted(() => ({ userId: "alice", companyId: "company-a", settled: true, failed: false, isLoading: false, companyListError: false, companyListReady: true, companyIds: ["company-a", "company-b"], slots: [] as ResolvedPluginSlot[], errorMessage: null as string | null, mobile: false, collapsed: false, close: vi.fn(), signOut: vi.fn(), props: null as PluginOrganizationSwitcherProps | null }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => state, useCompanyListQuery: () => ({ isSuccess: state.companyListReady, isError: state.companyListError, data: { unauthorized: false, companies: state.companyIds.map(id => ({ id, name: "Acme", issuePrefix: "ACME", logoUrl: "/logo" })) } }) }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: state.userId } }) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId, selectedCompany: { name: "Acme", issuePrefix: "ACME", logoUrl: "/logo" } }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: state.mobile, setSidebarOpen: state.close, collapsed: state.collapsed, peeking: false }) }));
vi.mock("@/hooks/useSignOut", () => ({ useSignOut: () => ({ mutate: state.signOut, isPending: false }) }));
vi.mock("./CompanyPatternIcon", () => ({ CompanyPatternIcon: () => <span>icon</span> }));
vi.mock("@/plugins/slots", async (importOriginal) => ({ ...await importOriginal<object>(), usePluginSlots: () => state }));
const slot: ResolvedPluginSlot = { type: "organizationSwitcher", id: "switcher", displayName: "Organizations", exportName: "Switcher", pluginId: "plugin-1", pluginKey: "fixture.switcher", pluginDisplayName: "Fixture", pluginVersion: "1" };
let root: Root | undefined;
let container: HTMLDivElement;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function render() {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  flushSync(() => root!.render(<QueryClientProvider client={client}><PluginOrganizationSwitcher><button>Built-in organizations</button></PluginOrganizationSwitcher></QueryClientProvider>));
}
afterEach(() => {
  if (root) flushSync(() => root!.unmount()); root = undefined; container?.remove(); client.clear(); vi.restoreAllMocks();
  Object.assign(state, { userId: "alice", companyId: "company-a", settled: true, failed: false, isLoading: false, companyListError: false, companyListReady: true, companyIds: ["company-a", "company-b"], slots: [], errorMessage: null, mobile: false, collapsed: false, props: null });
  state.close.mockClear(); state.signOut.mockClear();
});
function register() {
  registerPluginReactComponent(slot.pluginKey, slot.exportName, (props) => {
    const host = (props as unknown as PluginOrganizationSwitcherProps).organizationSwitcher;
    state.props = { organizationSwitcher: host };
    const [selected, setSelected] = useState(false);
    return <button onClick={() => setSelected(true)}>{selected ? "selected" : "Private organizations"}</button>;
  });
  state.slots = [slot];
}
describe("organization navigation replacement", () => {
  it("reserves the trigger until identity, companies, discovery and the module are ready", () => {
    state.settled = false;
    render();
    expect(container.textContent).toBe("");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    state.settled = true; state.companyListReady = false; render();
    expect(container.textContent).toBe("");
    state.companyListReady = true; state.isLoading = true; render();
    expect(container.textContent).toBe("");
    state.slots = [{ ...slot, exportName: "Delayed" }]; render();
    expect(container.textContent).toBe("");
    registerPluginReactComponent(slot.pluginKey, "Delayed", () => <button>Resolved organization</button>);
    state.isLoading = false; render();
    expect(container.textContent).toBe("Resolved organization");
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
  it("keeps built-in navigation for absent, ambiguous or failed discovery", () => {
    render(); expect(container.textContent).toBe("Built-in organizations");
    register(); state.slots = [slot, { ...slot, id: "other" }]; render(); expect(container.textContent).toBe("Built-in organizations");
    state.slots = [slot]; state.errorMessage = "offline"; render(); expect(container.textContent).toBe("Built-in organizations");
    state.errorMessage = null; state.settled = false; state.failed = true; render(); expect(container.textContent).toBe("Built-in organizations");
    state.failed = false; state.settled = true; state.companyListReady = false; state.companyListError = true;
    render(); expect(container.textContent).toBe("Built-in organizations");
  });
  it("falls back when a declared module is missing or rendering fails", () => {
    state.slots = [{ ...slot, exportName: "Missing" }]; render(); expect(container.textContent).toBe("Built-in organizations");
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerPluginReactComponent(slot.pluginKey, "Broken", () => { throw new Error("render failed"); });
    state.slots = [{ ...slot, exportName: "Broken" }]; render(); expect(container.textContent).toBe("Built-in organizations");
  });
  it("does not mount a new account with the previous account's company selection", () => {
    register(); render();
    state.userId = "bob";
    state.companyListReady = false;
    state.props = null;
    render();
    expect(container.querySelector('[aria-label="Loading organization"]')).not.toBeNull();
    expect(container.textContent).toBe("");
    expect(state.props).toBeNull();
    state.companyListReady = true;
    state.companyIds = ["company-b"];
    render();
    expect(container.querySelector('[aria-label="Loading organization"]')).not.toBeNull();
    expect(container.textContent).toBe("");
    expect(state.props).toBeNull();
    state.companyId = "company-b";
    render();
    expect(container.textContent).toBe("Private organizations");
  });
  it("keeps required navigation when the replacement cannot accept React callbacks", () => {
    registerPluginWebComponent(slot.pluginKey, "WebSwitcher", "fixture-switcher");
    state.slots = [{ ...slot, exportName: "WebSwitcher" }];
    render();
    expect(container.textContent).toBe("Built-in organizations");
  });
  it("renders one replacement, keeps host controls, and clears state across identity changes", () => {
    register(); state.mobile = true; state.collapsed = true; render();
    expect(container.textContent).toBe("Private organizations");
    const host = state.props!.organizationSwitcher;
    expect(host.currentCompany).toEqual({ name: "Acme", logoUrl: "/logo" }); expect(host.collapsed).toBe(true);
    flushSync(() => host.onOpenChange(true)); expect(state.props!.organizationSwitcher.open).toBe(true);
    flushSync(() => host.onNavigate()); expect(state.close).toHaveBeenCalledWith(false); expect(state.props!.organizationSwitcher.open).toBe(false);
    host.onSignOut(); expect(state.signOut).toHaveBeenCalledOnce();
    flushSync(() => container.querySelector("button")!.click()); render(); expect(container.textContent).toBe("selected");
    state.userId = "bob"; render(); expect(container.textContent).toBe("Private organizations");
    flushSync(() => container.querySelector("button")!.click()); state.companyId = "company-b"; render(); expect(container.textContent).toBe("Private organizations");
  });
});
