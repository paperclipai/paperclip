// @vitest-environment jsdom

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginUiSlotDeclaration } from "@paperclipai/shared";
import type { PluginUiContribution } from "@/api/plugins";
import {
  PluginSlotMount,
  _collectRegisterableExportNamesForTests,
  _resetPluginModuleLoader,
  registerPluginWebComponent,
  usePluginSlots,
  type ResolvedPluginSlot,
} from "./slots";

// Host tests for the manifest-declared admin gate. The gate calls
// `pluginsApi.bridgeGetData(pluginId, slot.adminGateHandler, ...)`, so we drive
// the REAL `usePluginSlots` hook and assert the exact bridge call + fail-closed
// filtering.
const mockPluginsApi = vi.hoisted(() => ({
  listUiContributions: vi.fn(),
  bridgeGetData: vi.fn(),
}));

vi.mock("@/api/plugins", () => ({ pluginsApi: mockPluginsApi }));

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) {
    flushSync(() => {
      root.unmount();
    });
  }
  roots = [];
  _resetPluginModuleLoader();
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

// ---------------------------------------------------------------------------
// The admin gate is driven by the MANIFEST-declared `adminGateHandler`, not a
// host hardcode. These cases render the real `usePluginSlots` hook against a
// mocked bridge and assert (1) the exact handler name is queried and the slot
// is visible when admin, (2) a gated slot without a declared handler is never
// queried and stays hidden (fail-closed), (3) switching the active company
// re-runs the check.
// ---------------------------------------------------------------------------

let captured: ReturnType<typeof usePluginSlots> | null = null;

function GateHarness({ filters }: { filters: Parameters<typeof usePluginSlots>[0] }) {
  captured = usePluginSlots(filters);
  return null;
}

function contribution(slots: PluginUiSlotDeclaration[]): PluginUiContribution {
  return {
    pluginId: "plugin-1",
    pluginKey: "plugin-1-key",
    displayName: "Plugin One",
    version: "1.0.0",
    uiEntryFile: "index.js",
    slots,
    launchers: [],
  };
}

async function settle(): Promise<void> {
  // Let react-query resolve its async queries and React re-render.
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}

function mountGate() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const render = (filters: Parameters<typeof usePluginSlots>[0]) => {
    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(GateHarness, { filters }),
        ),
      );
    });
  };
  return { render };
}

describe("admin-gated slots resolve via the manifest-declared adminGateHandler", () => {
  const originalFetch = globalThis.fetch;
  const originalBridge = (globalThis as unknown as { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__;

  beforeEach(() => {
    captured = null;
    mockPluginsApi.listUiContributions.mockReset();
    mockPluginsApi.bridgeGetData.mockReset();
    // Neutralize plugin UI module loading (irrelevant to the gate): make the
    // loader's fetch reject so it fails closed and caught, never touching a real bundle.
    (globalThis as unknown as { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__ = {};
    (globalThis as { fetch: unknown }).fetch = vi.fn(async () => {
      throw new Error("no plugin module in test");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
    (globalThis as unknown as { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__ = originalBridge;
    vi.restoreAllMocks();
  });

  it("queries the slot's adminGateHandler and shows the slot for an admin", async () => {
    mockPluginsApi.listUiContributions.mockResolvedValue([
      contribution([
        {
          type: "sidebar",
          id: "gated-sidebar",
          displayName: "Gated",
          exportName: "GatedSidebar",
          requiresAdmin: true,
          adminGateHandler: "customAdminHandler",
        },
      ]),
    ]);
    mockPluginsApi.bridgeGetData.mockResolvedValue({ data: { isAdmin: true } });

    const { render } = mountGate();
    render({ slotTypes: ["sidebar"], companyId: "company-1" });
    await settle();

    // The host called the MANIFEST-declared handler.
    expect(mockPluginsApi.bridgeGetData).toHaveBeenCalledWith(
      "plugin-1",
      "customAdminHandler",
      undefined,
      "company-1",
    );
    // The admin resolves true → the gated slot is visible.
    expect((captured?.slots ?? []).map((s) => s.id)).toContain("gated-sidebar");
  });

  it("never queries and keeps hidden a gated slot that declares no adminGateHandler (fail-closed)", async () => {
    mockPluginsApi.listUiContributions.mockResolvedValue([
      contribution([
        {
          type: "sidebar",
          id: "gated-no-handler",
          displayName: "Gated No Handler",
          exportName: "GatedNoHandlerSidebar",
          requiresAdmin: true,
          // adminGateHandler intentionally absent
        },
        {
          type: "sidebar",
          id: "open-sidebar",
          displayName: "Open",
          exportName: "OpenSidebar",
        },
      ]),
    ]);
    mockPluginsApi.bridgeGetData.mockResolvedValue({ data: { isAdmin: true } });

    const { render } = mountGate();
    render({ slotTypes: ["sidebar"], companyId: "company-1" });
    await settle();

    // A gated slot with no declared handler is never queried …
    expect(mockPluginsApi.bridgeGetData).not.toHaveBeenCalled();
    const visibleIds = (captured?.slots ?? []).map((s) => s.id);
    // … and stays hidden, while the non-gated slot passes through.
    expect(visibleIds).not.toContain("gated-no-handler");
    expect(visibleIds).toContain("open-sidebar");
  });

  it("re-runs the check on company switch: visible for the company where the user is admin, hidden for the other", async () => {
    mockPluginsApi.listUiContributions.mockResolvedValue([
      contribution([
        {
          type: "sidebar",
          id: "gated-sidebar",
          displayName: "Gated",
          exportName: "GatedSidebar",
          requiresAdmin: true,
          adminGateHandler: "customAdminHandler",
        },
      ]),
    ]);
    // Admin of company-1 only.
    mockPluginsApi.bridgeGetData.mockImplementation(
      async (_pluginId: string, _key: string, _params: unknown, companyId: string | null) => ({
        data: { isAdmin: companyId === "company-1" },
      }),
    );

    const { render } = mountGate();

    render({ slotTypes: ["sidebar"], companyId: "company-1" });
    await settle();
    expect((captured?.slots ?? []).map((s) => s.id)).toContain("gated-sidebar");

    // Switch to company-2 → the host re-runs the check for the new company.
    render({ slotTypes: ["sidebar"], companyId: "company-2" });
    await settle();
    expect(mockPluginsApi.bridgeGetData).toHaveBeenCalledWith(
      "plugin-1",
      "customAdminHandler",
      undefined,
      "company-2",
    );
    expect((captured?.slots ?? []).map((s) => s.id)).not.toContain("gated-sidebar");
  });
});
