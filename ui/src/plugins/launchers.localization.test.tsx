// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { PluginUiContribution } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { PluginLauncherButton, PluginLauncherProvider, type ResolvedPluginLauncher } from "./launchers";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), load: vi.fn().mockResolvedValue(undefined), navigate: vi.fn(), action: vi.fn() }));
vi.mock("./slots", () => ({ resolveRegisteredPluginComponent: mocks.resolve, ensurePluginContributionLoaded: mocks.load }));
vi.mock("@/lib/router", () => ({ useNavigate: () => mocks.navigate, useLocation: () => ({ key: "unchanged-route" }) }));
vi.mock("@/api/plugins", () => ({ pluginsApi: { bridgePerformAction: mocks.action } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let client: QueryClient | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  client?.clear();
  root = undefined;
  host = undefined;
  client = undefined;
  vi.restoreAllMocks();
  mocks.resolve.mockReset();
  mocks.load.mockClear();
  mocks.navigate.mockClear();
  mocks.action.mockClear();
  await i18n.changeLanguage("en");
});
const launcher: ResolvedPluginLauncher = {
  id: "raw-launcher", displayName: "Custom launcher", placementZone: "globalToolbarButton",
  action: { type: "openModal", target: "RAW_EXPORT" }, pluginId: "plugin-raw", pluginKey: "vendor.raw",
  pluginDisplayName: "Custom plugin", pluginVersion: "1.0.0", uiEntryFile: "ui.js",
};
const contribution: PluginUiContribution = { pluginId: "plugin-raw", pluginKey: "vendor.raw", displayName: "Custom plugin", version: "1.0.0", uiEntryFile: "ui.js", slots: [], launchers: [launcher] };
async function mountAndOpen() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "raw-user" } });
  await act(async () => root?.render(<QueryClientProvider client={client!}><PluginLauncherProvider><PluginLauncherButton launcher={launcher} contribution={contribution} context={{ companyId: "company-raw" }} /></PluginLauncherProvider></QueryClientProvider>));
  await act(async () => host?.querySelector<HTMLButtonElement>("button")?.click());
}
async function locale(lang: "en" | "ru") { await act(async () => { await i18n.changeLanguage(lang); }); }

describe("Plugin launcher localization", () => {
  it("updates an open launcher error and close button without changing target metadata or firing plugin actions", async () => {
    mocks.resolve.mockReturnValue(null);
    const before = JSON.stringify({ launcher, contribution });
    await mountAndOpen();
    const dialog = host?.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Custom plugin: could not resolve launcher target "RAW_EXPORT".');
    const initialResolutions = mocks.resolve.mock.calls.length;
    await locale("ru");
    expect(dialog?.textContent).toContain("Custom plugin: не удалось определить целевой компонент «RAW_EXPORT».");
    expect(dialog?.textContent).toContain("Custom launcher");
    expect(dialog?.textContent).toContain("Закрыть");
    expect(mocks.resolve).toHaveBeenCalledTimes(initialResolutions);
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(JSON.stringify({ launcher, contribution })).toBe(before);
    await locale("en");
    expect(dialog?.textContent).toContain("Close");
    await act(async () => Array.from(dialog!.querySelectorAll("button")).find(b => b.textContent === "Close")?.click());
    expect(host?.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps a caught renderer failure mounted and reactive without rerunning the plugin component", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const crashing = vi.fn(() => { throw new Error("RAW_PLUGIN_ERROR"); });
    mocks.resolve.mockReturnValue({ kind: "react", component: crashing });
    await mountAndOpen();
    expect(host?.textContent).toContain("Custom plugin: failed to render");
    const calls = crashing.mock.calls.length;
    await locale("ru");
    expect(host?.textContent).toContain("Custom plugin: не удалось отобразить");
    expect(crashing).toHaveBeenCalledTimes(calls);
    expect(mocks.action).not.toHaveBeenCalled();
  });
});
