// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginLauncherActionDeclaration } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginLauncherOutlet, PluginLauncherProvider } from "./launchers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  action: { type: "navigate", target: "/plugin-page" } as PluginLauncherActionDeclaration,
  navigate: vi.fn(),
  bridgePerformAction: vi.fn(async () => undefined),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => fixture.navigate,
  useLocation: () => ({ pathname: "/ACME/issues", search: "", hash: "" }),
}));
vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    listUiContributions: async () => [{
      pluginId: "plugin",
      pluginKey: "example.plugin",
      displayName: "Example",
      version: "1.0.0",
      uiEntryFile: "index.js",
      slots: [],
      launchers: [{ id: "open", displayName: "Open page", placementZone: "sidebar", action: fixture.action }],
    }],
    bridgePerformAction: fixture.bridgePerformAction,
  },
}));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  fixture.navigate.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
});

async function clickLauncher(action: PluginLauncherActionDeclaration) {
  fixture.action = action;
  const onNavigate = vi.fn();
  vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <PluginLauncherProvider>
        <PluginLauncherOutlet placementZones={["sidebar"]} context={{ companyId: "company", companyPrefix: "ACME" }} onNavigate={onNavigate} />
      </PluginLauncherProvider>
    </QueryClientProvider>,
  ));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const button = [...container.querySelectorAll("button")].find(element => element.textContent === "Open page")!;
  await act(async () => { button.click(); });
  return onNavigate;
}

describe("PluginLauncherOutlet onNavigate", () => {
  it.each([
    [{ type: "navigate", target: "/plugin-page" }, true],
    [{ type: "deepLink", target: "/plugin-page" }, true],
    [{ type: "deepLink", target: "https://example.com/page" }, false],
    [{ type: "performAction", target: "refresh" }, false],
  ] as Array<[PluginLauncherActionDeclaration, boolean]>)("reports in-app navigation for %o: %s", async (action, navigates) => {
    const onNavigate = await clickLauncher(action);
    expect(onNavigate).toHaveBeenCalledTimes(navigates ? 1 : 0);
    expect(fixture.navigate).toHaveBeenCalledTimes(navigates ? 1 : 0);
  });
});
