// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import type { PluginUiContribution } from "@/api/plugins";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { PluginLauncherOutlet, PluginLauncherProvider, usePluginLaunchers } from "./launchers";
import { _resetPluginModuleLoader, PluginSlotOutlet, registerPluginReactComponent, usePluginSlots } from "./slots";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));

const contribution: PluginUiContribution = {
  pluginId: "fixture", pluginKey: "fixture.sidebar", displayName: "Fixture", version: "1",
  uiEntryFile: "index.js",
  slots: [
    { type: "sidebar", id: "nav", displayName: "Nav", exportName: "SidebarItem" },
    { type: "sidebarPanel", id: "panel", displayName: "Panel", exportName: "SidebarPanel" },
  ],
  launchers: [{
    id: "open", displayName: "Fixture launcher", placementZone: "sidebar",
    action: { type: "navigate", target: "/fixture" },
  }],
};
const context = { companyId: "company-1", companyPrefix: "PAP" };
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

function HookProbe() {
  const slots = usePluginSlots({ slotTypes: ["sidebar"], companyId: context.companyId });
  const launchers = usePluginLaunchers({ placementZones: ["sidebar"], companyId: context.companyId });
  return (
    <span data-testid="probe">
      {`slots:${slots.isLoading ? "loading" : "settled"}:${slots.errorMessage ?? "-"}|launchers:${launchers.isLoading ? "loading" : "settled"}:${launchers.errorMessage ?? "-"}`}
    </span>
  );
}

async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PluginLauncherProvider>
          <PluginSlotOutlet slotTypes={["sidebar"]} context={context} />
          <PluginLauncherOutlet placementZones={["sidebar"]} context={context} />
          <PluginSlotOutlet slotTypes={["sidebarPanel"]} context={context} />
          <HookProbe />
        </PluginLauncherProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
}

const probeText = () => container.querySelector('[data-testid="probe"]')?.textContent ?? "";

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Module and session fetches stay pending; components are registered directly.
  vi.stubGlobal("__paperclipPluginBridge__", {});
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); client.clear(); _resetPluginModuleLoader();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("collapses silently and stays loading when contributions cannot be fetched during an outage", async () => {
  vi.spyOn(pluginsApi, "listUiContributions").mockRejectedValue(new TypeError("Failed to fetch"));
  await render();
  await vi.waitFor(() => expect(client.getQueryState(queryKeys.plugins.uiContributions)?.status).toBe("error"));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(container.textContent).not.toContain("unavailable");
  expect(container.textContent).not.toContain("Failed to fetch");
  expect(container.querySelector(".text-destructive")).toBeNull();
  // Nothing has loaded yet: the hooks report loading, not an error, so pages show a placeholder.
  expect(probeText()).toBe("slots:loading:-|launchers:loading:-");
});

it("reports a readable message, never a raw code, for a real failure", async () => {
  vi.spyOn(pluginsApi, "listUiContributions").mockRejectedValue(new ApiError("access_denied", 403, { error: "access_denied" }));
  await render();
  await vi.waitFor(() => expect(client.getQueryState(queryKeys.plugins.uiContributions)?.status).toBe("error"));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(container.textContent).not.toContain("access_denied");
  expect(container.querySelector(".text-destructive")).toBeNull();
  expect(probeText()).toContain("slots:settled:You don’t have permission to do that.");
  expect(probeText()).toContain("launchers:settled:You don’t have permission to do that.");
});

it("keeps the last loaded slots and launchers when a refetch fails", async () => {
  vi.spyOn(pluginsApi, "listUiContributions").mockRejectedValue(new ApiError("tenant_app_unavailable", 503, { error: "tenant_app_unavailable" }));
  registerPluginReactComponent("fixture.sidebar", "SidebarItem", () => <span>Fixture sidebar item</span>);
  registerPluginReactComponent("fixture.sidebar", "SidebarPanel", () => <span>Fixture sidebar panel</span>);
  client.setQueryData(queryKeys.plugins.uiContributions, [contribution]);
  await render();
  expect(container.textContent).toContain("Fixture sidebar item");
  expect(container.textContent).toContain("Fixture sidebar panel");

  await act(async () => {
    await client.refetchQueries({ queryKey: queryKeys.plugins.uiContributions });
    // React Query notifies observers on a timer; let the error render land.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(client.getQueryState(queryKeys.plugins.uiContributions)?.status).toBe("error");
  expect(container.textContent).not.toContain("unavailable");
  expect(container.textContent).toContain("Fixture sidebar item");
  expect(container.textContent).toContain("Fixture sidebar panel");
  expect(container.textContent).toContain("Fixture launcher");
  // The slots probe stays "loading" only because the fixture module fetch never settles.
  expect(probeText()).toMatch(/^slots:(?:loading|settled):-\|launchers:settled:-$/);
});
