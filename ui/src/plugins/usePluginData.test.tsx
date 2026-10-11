// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { PluginBridgeContext, usePluginData, type PluginBridgeContextValue } from "./bridge";

const mockPluginsApi = vi.hoisted(() => ({ bridgeGetData: vi.fn() }));
vi.mock("@/api/plugins", () => ({ pluginsApi: mockPluginsApi }));
// The hook shares the app-wide retry policy; fail fast here so a transient
// error reaches the keep-or-clear decision without a 30-second backoff.
vi.mock("@/lib/query-client", () => ({ shouldRetryRequest: () => false, retryDelayFor: () => 0 }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const unavailable = () => new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" });

const bridge: PluginBridgeContextValue = {
  pluginId: "files",
  hostContext: {
    companyId: "company-1",
    companyPrefix: null,
    projectId: null,
    entityId: null,
    entityType: null,
    userId: null,
    renderEnvironment: null,
  },
};

type Snapshot = { data: unknown; loading: boolean; error: string | null };

describe("usePluginData", () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshots: Snapshot[];

  function Consumer({ path }: { path: string }) {
    const { data, loading, error } = usePluginData<{ content: string }>("file-content", { path });
    snapshots.push({ data, loading, error: error?.code ?? null });
    return null;
  }

  function render(path: string) {
    act(() => {
      root.render(
        <PluginBridgeContext.Provider value={bridge}>
          <Consumer path={path} />
        </PluginBridgeContext.Provider>,
      );
    });
  }

  const last = () => snapshots[snapshots.length - 1]!;
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    snapshots = [];
    mockPluginsApi.bridgeGetData.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not show the previous request's data when a new request fails transiently", async () => {
    mockPluginsApi.bridgeGetData.mockResolvedValueOnce({ data: { content: "alpha" } });
    render("a.txt");
    await settle();
    expect(last().data).toEqual({ content: "alpha" });

    mockPluginsApi.bridgeGetData.mockRejectedValueOnce(unavailable());
    render("b.txt");
    await settle();
    expect(mockPluginsApi.bridgeGetData).toHaveBeenLastCalledWith(
      "files",
      "file-content",
      { path: "b.txt" },
      "company-1",
      null,
    );
    expect(last().loading).toBe(false);
    expect(last().data).toBeNull();
    expect(last().error).not.toBeNull();
  });

  it("keeps data through a transient failure of the same request", async () => {
    mockPluginsApi.bridgeGetData.mockResolvedValueOnce({ data: { content: "alpha" } });
    let refresh!: () => void;
    function Refreshing() {
      const result = usePluginData<{ content: string }>("file-content", { path: "a.txt" });
      refresh = result.refresh;
      snapshots.push({ data: result.data, loading: result.loading, error: result.error?.code ?? null });
      return null;
    }
    act(() => {
      root.render(
        <PluginBridgeContext.Provider value={bridge}>
          <Refreshing />
        </PluginBridgeContext.Provider>,
      );
    });
    await settle();
    expect(last().data).toEqual({ content: "alpha" });

    mockPluginsApi.bridgeGetData.mockRejectedValueOnce(unavailable());
    act(() => refresh());
    await settle();
    expect(mockPluginsApi.bridgeGetData).toHaveBeenCalledTimes(2);
    expect(last()).toEqual({ data: { content: "alpha" }, loading: false, error: null });
  });
});
