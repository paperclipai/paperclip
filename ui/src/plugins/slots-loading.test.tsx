// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginUiContribution } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { _resetPluginModuleLoader, ensurePluginContributionLoaded, usePluginSlots } from "./slots";

const contribution: PluginUiContribution = {
  pluginId: "navigation", pluginKey: "fixture.navigation", displayName: "Navigation", version: "1",
  uiEntryFile: "index.js", launchers: [],
  slots: [{ type: "organizationSwitcher", id: "navigation", displayName: "Organizations", exportName: "Switcher" }],
};
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
function Consumer() {
  const { isLoading } = usePluginSlots({ slotTypes: ["organizationSwitcher"] });
  return <span>{isLoading ? "Loading" : "Ready"}</span>;
}
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><Consumer /></QueryClientProvider>));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("__paperclipPluginBridge__", {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); client.clear(); _resetPluginModuleLoader();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it("does not wait for or load modules for unrelated slots", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  client.setQueryData(queryKeys.plugins.uiContributions, [{ ...contribution,
    slots: [{ type: "page", id: "other", displayName: "Other", exportName: "Page", routePath: "other" }],
  }]);
  await render();
  expect(container.textContent).toBe("Ready");
  expect(fetch).not.toHaveBeenCalled();
});
it("settles when a module import started by another consumer fails", async () => {
  let reject!: (error: Error) => void;
  const fetch = vi.fn(() => new Promise<Response>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  vi.stubGlobal("fetch", fetch); vi.spyOn(console, "error").mockImplementation(() => {});
  client.setQueryData(queryKeys.plugins.uiContributions, [contribution]);
  const loading = ensurePluginContributionLoaded(contribution);
  await render();
  expect(container.textContent).toBe("Loading");
  await act(async () => { reject(new Error("unavailable")); await loading; });
  expect(container.textContent).toBe("Ready");
  expect(fetch).toHaveBeenCalledOnce();
});
