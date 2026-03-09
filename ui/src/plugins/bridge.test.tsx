import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    bridgeGetData: vi.fn(),
    bridgePerformAction: vi.fn(),
  },
}));

import { pluginsApi } from "@/api/plugins";
import { usePluginData, _resetBridgeState } from "./bridge";
import {
  PluginSlotMount,
  registerPluginReactComponent,
  _resetPluginModuleLoader,
  type ResolvedPluginSlot,
} from "./slots";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderNode(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    rerender: (next: ReactNode) =>
      act(() => {
        root.render(next);
      }),
    unmount: () =>
      act(() => {
        root.unmount();
        container.remove();
      }),
  };
}

async function flushBridgeUpdates() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function BridgeProbe() {
  const { data, loading, error } = usePluginData<{ value: string }>(
    "workspaces",
    { projectId: "project-1" },
  );

  return (
    <div data-testid="bridge-probe-status">
      {loading ? "loading" : error ? `error:${error.code}` : (data?.value ?? "none")}
    </div>
  );
}

const slot: ResolvedPluginSlot = {
  id: "files-tab",
  type: "detailTab",
  displayName: "Files",
  exportName: "BridgeProbe",
  entityTypes: ["project"],
  pluginId: "plugin-1",
  pluginKey: "acme.files",
  pluginDisplayName: "Acme Files",
  pluginVersion: "1.0.0",
};

const baseContext = {
  entityId: "project-1",
  entityType: "project" as const,
};

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  _resetBridgeState();
  _resetPluginModuleLoader();
  document.body.innerHTML = "";
});

describe("plugin bridge regressions", () => {
  it("re-fetches plugin data when company context becomes available after initial mount", async () => {
    registerPluginReactComponent("acme.files", "BridgeProbe", BridgeProbe);
    vi.mocked(pluginsApi.bridgeGetData)
      .mockResolvedValueOnce({ data: { value: "no-company" } })
      .mockResolvedValueOnce({ data: { value: "with-company" } });

    const view = renderNode(
      <PluginSlotMount
        slot={slot}
        context={{ ...baseContext, companyId: null }}
      />,
    );

    await flushBridgeUpdates();

    expect(pluginsApi.bridgeGetData).toHaveBeenCalledTimes(1);
    expect(pluginsApi.bridgeGetData).toHaveBeenNthCalledWith(
      1,
      "plugin-1",
      "workspaces",
      { projectId: "project-1" },
      null,
      null,
    );
    expect(view.container.querySelector("[data-testid='bridge-probe-status']")?.textContent).toBe("no-company");

    view.rerender(
      <PluginSlotMount
        slot={slot}
        context={{ ...baseContext, companyId: "company-1" }}
      />,
    );

    await flushBridgeUpdates();

    expect(pluginsApi.bridgeGetData).toHaveBeenCalledTimes(2);
    expect(pluginsApi.bridgeGetData).toHaveBeenNthCalledWith(
      2,
      "plugin-1",
      "workspaces",
      { projectId: "project-1" },
      "company-1",
      null,
    );
    expect(view.container.querySelector("[data-testid='bridge-probe-status']")?.textContent).toBe("with-company");
    view.unmount();
  });

  it("retries transient WORKER_UNAVAILABLE bridge errors without requiring remount", async () => {
    vi.useFakeTimers();
    registerPluginReactComponent("acme.files", "BridgeProbe", BridgeProbe);
    vi.mocked(pluginsApi.bridgeGetData)
      .mockRejectedValueOnce(
        new ApiError("worker not ready", 502, {
          code: "WORKER_UNAVAILABLE",
          message: "Plugin worker is starting",
        }),
      )
      .mockResolvedValueOnce({ data: { value: "ready" } });

    const view = renderNode(
      <PluginSlotMount
        slot={slot}
        context={{ ...baseContext, companyId: "company-1" }}
      />,
    );

    await flushBridgeUpdates();
    expect(pluginsApi.bridgeGetData).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await flushBridgeUpdates();

    expect(pluginsApi.bridgeGetData).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector("[data-testid='bridge-probe-status']")?.textContent).toBe("ready");
    view.unmount();
  });
});
