// @vitest-environment jsdom

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePluginLaunchers } from "./launchers";

const mockPluginsApi = vi.hoisted(() => ({
  listUiContributions: vi.fn(),
  bridgePerformAction: vi.fn(),
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

describe("usePluginLaunchers company filtering", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: any = null;

  function Harness({ companyId }: { companyId?: string | null }) {
    captured = usePluginLaunchers({ placementZones: ["toolbarButton"], companyId });
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

  it("excludes launchers from a plugin's contribution when it is filtered out for the company (disabled plugin never reaches the client)", async () => {
    // Simulates the server-side per-company enablement filter: a disabled
    // plugin's contribution (and thus its launchers) never appears in the
    // /api/plugins/ui-contributions response for that company.
    mockPluginsApi.listUiContributions.mockResolvedValue([]);
    const cleanup = await renderHook("company-1");

    expect(captured.launchers).toEqual([]);
    cleanup();
  });
});
