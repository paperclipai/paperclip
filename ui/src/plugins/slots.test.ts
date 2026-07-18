// @vitest-environment jsdom

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PluginSlotMount,
  _collectRegisterableExportNamesForTests,
  _resetPluginModuleLoader,
  registerPluginWebComponent,
  usePluginSlots,
  type ResolvedPluginSlot,
} from "./slots";

const mockPluginsApi = vi.hoisted(() => ({
  listUiContributions: vi.fn(),
}));

vi.mock("../api/plugins", () => ({ pluginsApi: mockPluginsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

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

describe("usePluginSlots company filtering", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: any = null;

  function Harness({ companyId }: { companyId?: string | null }) {
    captured = usePluginSlots({ slotTypes: ["toolbarButton"], companyId });
    return null;
  }

  async function renderHook(companyId?: string | null) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness, { companyId }),
        ),
      );
    });
    await flushReact();
    return () => {
      root.unmount();
      container.remove();
    };
  }

  beforeEach(() => {
    captured = null;
    mockPluginsApi.listUiContributions.mockReset();
    mockPluginsApi.listUiContributions.mockResolvedValue([]);
  });

  it("fetches without a companyId when the filter omits it", async () => {
    const cleanup = await renderHook(undefined);
    expect(mockPluginsApi.listUiContributions).toHaveBeenCalledWith(undefined);
    cleanup();
  });

  it("fetches with the companyId when the filter provides it", async () => {
    const cleanup = await renderHook("company-1");
    expect(mockPluginsApi.listUiContributions).toHaveBeenCalledWith("company-1");
    cleanup();
  });

  it("keys the query on companyId so switching companies re-fetches", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness, { companyId: "company-1" }),
        ),
      );
    });
    await flushReact();
    expect(mockPluginsApi.listUiContributions).toHaveBeenCalledTimes(1);
    expect(mockPluginsApi.listUiContributions).toHaveBeenLastCalledWith("company-1");

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness, { companyId: "company-2" }),
        ),
      );
    });
    await flushReact();
    expect(mockPluginsApi.listUiContributions).toHaveBeenCalledTimes(2);
    expect(mockPluginsApi.listUiContributions).toHaveBeenLastCalledWith("company-2");

    root.unmount();
    container.remove();
  });
});
