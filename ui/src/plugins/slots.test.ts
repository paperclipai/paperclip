// @vitest-environment jsdom

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginUiSlotPlacement } from "@paperclipai/shared";
import {
  PluginSlotMount,
  usePluginSlots,
  _collectRegisterableExportNamesForTests,
  _resetPluginModuleLoader,
  registerPluginWebComponent,
  type ResolvedPluginSlot,
} from "./slots";

const mockPluginsApi = vi.hoisted(() => ({
  listUiContributions: vi.fn(),
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) {
    flushSync(() => {
      root.unmount();
    });
  }
  roots = [];
  _resetPluginModuleLoader();
  vi.clearAllMocks();
});

describe("plugin slot export registration", () => {
  it("keeps declared missing exports visible for diagnostics", () => {
    const exports = _collectRegisterableExportNamesForTests(
      { Page: () => null },
      new Set(["Page", "MissingRouteSidebar"]),
    );

    expect([...exports]).toEqual(["Page", "MissingRouteSidebar"]);
  });

  it("registers component-like module exports even when the current contribution did not declare them", () => {
    const exports = _collectRegisterableExportNamesForTests(
      {
        Page: () => null,
        RouteSidebar: () => null,
        webComponentTag: "paperclip-widget",
        metadata: { ignored: true },
        count: 1,
        default: () => null,
      },
      new Set(["Page"]),
    );

    expect(exports).toEqual(new Set(["Page", "RouteSidebar", "webComponentTag"]));
  });

  it("updates an already-mounted placeholder when the slot export registers later", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const slot: ResolvedPluginSlot = {
      type: "routeSidebar",
      id: "content-machine-sidebar",
      displayName: "Content",
      exportName: "ContentMachineRouteSidebar",
      routePath: "content-machine",
      pluginId: "content-machine-plugin",
      pluginKey: "content-machine",
      pluginDisplayName: "Content Machine",
      pluginVersion: "1.0.0",
    };

    flushSync(() => {
      root.render(createElement(PluginSlotMount, {
        slot,
        context: { companyId: "company-1", companyPrefix: "PAP" },
        missingBehavior: "placeholder",
      }));
    });

    expect(container.textContent).toContain("Content Machine: Content");

    flushSync(() => {
      registerPluginWebComponent("content-machine", "ContentMachineRouteSidebar", "paperclip-test-sidebar");
    });

    expect(container.textContent).not.toContain("Content Machine: Content");
    expect(container.querySelector("paperclip-test-sidebar")).not.toBeNull();
  });
});

describe("usePluginSlots placement filtering", () => {
  function PlacementProbe({ placement }: { placement?: PluginUiSlotPlacement }) {
    const { slots } = usePluginSlots({ slotTypes: ["dashboardWidget"], placement });
    return createElement(
      "div",
      { "data-testid": `probe-${placement ?? "all"}` },
      slots.map((slot) => slot.id).join(","),
    );
  }

  it("splits top-placement widgets from default dashboard widgets", async () => {
    mockPluginsApi.listUiContributions.mockResolvedValue([
      {
        pluginId: "plugin-widgets",
        pluginKey: "acme.widgets",
        displayName: "Widgets",
        version: "1.0.0",
        uiEntryFile: "index.js",
        slots: [
          {
            type: "dashboardWidget",
            id: "top-widget",
            displayName: "Top",
            exportName: "TopWidget",
            placement: "top",
          },
          {
            type: "dashboardWidget",
            id: "plain-widget",
            displayName: "Plain",
            exportName: "PlainWidget",
          },
        ],
        launchers: [],
      },
    ]);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(PlacementProbe, { placement: "top" }),
        createElement(PlacementProbe, { placement: "default" }),
        createElement(PlacementProbe, {}),
      ));
    });
    // Let the mocked contributions query resolve and re-render.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(container.querySelector('[data-testid="probe-top"]')?.textContent).toBe("top-widget");
    expect(container.querySelector('[data-testid="probe-default"]')?.textContent).toBe("plain-widget");
    expect(container.querySelector('[data-testid="probe-all"]')?.textContent).toBe("plain-widget,top-widget");
  });
});
