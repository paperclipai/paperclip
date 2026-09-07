// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t, useTranslation } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { pluginStatusLabel, pluginJobTriggerLabel } from "@/lib/plugin-display";
import { MissingPluginTabPlaceholder } from "./MissingPluginTabPlaceholder";
import { PluginSlotMount, registerPluginReactComponent, _resetPluginModuleLoader, type ResolvedPluginSlot } from "@/plugins/slots";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  _resetPluginModuleLoader();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

describe("Plugin localization", () => {
  it.each([
    [1, "Последняя 1 запись журнала"],
    [2, "Последние 2 записи журнала"],
    [5, "Последние 5 записей журнала"],
    [21, "Последняя 21 запись журнала"],
    [22, "Последние 22 записи журнала"],
    [25, "Последние 25 записей журнала"],
  ])("uses Russian log-entry forms for %i", async (count, expected) => {
    await i18n.changeLanguage("ru");
    expect(t("localizationPlugins.recentLogCount", { count })).toBe(expected);
  });

  it("switches mounted platform labels while preserving names, route and unknown plugin states", async () => {
    mount();
    function Panel() {
      useTranslation();
      return <>
        <span>{pluginStatusLabel("upgrade_pending")}</span>
        <span>{pluginJobTriggerLabel("schedule")}</span>
        <span>{pluginStatusLabel("vendor:custom-state")}</span>
        <MissingPluginTabPlaceholder defaultTabHref="/projects/raw-project" defaultTabLabel="User plugin tab" />
      </>;
    }
    await act(async () => root?.render(<Panel />));
    expect(container?.textContent).toContain("Workspace plugin tab is not available.");
    expect(container?.textContent).toContain("upgrade_pending");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container?.textContent).toContain("Вкладка плагина рабочей области недоступна.");
    expect(container?.textContent).toContain("Ожидает обновления");
    expect(container?.textContent).toContain("По расписанию");
    expect(container?.textContent).toContain("vendor:custom-state");
    expect(container?.querySelector("a")?.textContent).toBe("User plugin tab");
    expect(container?.querySelector("a")?.getAttribute("href")).toBe("/projects/raw-project");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container?.textContent).toContain("Workspace plugin tab is not available.");
    expect(container?.textContent).toContain("schedule");
  });

  it("switches the mounted class error-boundary message without modifying the raw error", async () => {
    mount();
    const rawError = new Error("VENDOR_RAW_DIAGNOSTIC");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    function BrokenPlugin(): never { throw rawError; }
    registerPluginReactComponent("vendor.plugin", "Broken", BrokenPlugin);
    const slot: ResolvedPluginSlot = {
      type: "page", id: "vendor-page", exportName: "Broken", displayName: "Vendor page",
      pluginId: "plugin-id", pluginKey: "vendor.plugin", pluginDisplayName: "Vendor Plugin", pluginVersion: "1.0.0",
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-id" } });
    await act(async () => root?.render(
      <QueryClientProvider client={queryClient}>
        <PluginSlotMount slot={slot} context={{ companyId: "company-id" }} />
      </QueryClientProvider>,
    ));
    expect(container?.textContent).toBe("Vendor Plugin: failed to render");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container?.textContent).toBe("Vendor Plugin: не удалось отобразить интерфейс");
    expect(consoleError).toHaveBeenCalledWith("Plugin slot render failed", expect.objectContaining({ error: rawError, pluginKey: "vendor.plugin" }));
    expect(rawError.message).toBe("VENDOR_RAW_DIAGNOSTIC");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container?.textContent).toBe("Vendor Plugin: failed to render");
  });
});
