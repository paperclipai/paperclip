import { afterEach, describe, expect, it, vi } from "vitest";
import pluginSdkPackage from "../../../packages/plugins/sdk/package.json";
import {
  JSONRPC_VERSION,
  type PluginLauncherRenderContextSnapshot,
  type PluginModalBoundsRequest,
  type PluginRenderCloseEvent,
} from "@paperclipai/plugin-sdk/protocol";
import {
  MetricCard as RootMetricCard,
  usePluginData as rootUsePluginData,
} from "@paperclipai/plugin-sdk/ui";
import { MetricCard as SubpathMetricCard } from "@paperclipai/plugin-sdk/ui/components";
import { usePluginData as subpathUsePluginData } from "@paperclipai/plugin-sdk/ui/hooks";
import type { PluginRenderEnvironmentContext } from "@paperclipai/plugin-sdk/ui/types";

describe("@paperclipai/plugin-sdk public exports", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { __paperclipPluginBridge__?: unknown })
      .__paperclipPluginBridge__;
  });

  it("declares protocol and ui subpath exports in package.json", () => {
    expect(pluginSdkPackage.exports).toMatchObject({
      "./protocol": {
        types: "./dist/protocol.d.ts",
        import: "./dist/protocol.js",
      },
      "./types": {
        types: "./dist/types.d.ts",
        import: "./dist/types.js",
      },
      "./ui/hooks": {
        types: "./dist/ui/hooks.d.ts",
        import: "./dist/ui/hooks.js",
      },
      "./ui/types": {
        types: "./dist/ui/types.d.ts",
        import: "./dist/ui/types.js",
      },
      "./ui/components": {
        types: "./dist/ui/components.d.ts",
        import: "./dist/ui/components.js",
      },
    });
  });

  it("resolves launcher and modal protocol types through the public protocol subpath", () => {
    const boundsRequest: PluginModalBoundsRequest = {
      bounds: "wide",
      minWidth: 480,
      maxHeight: 900,
    };
    const closeEvent: PluginRenderCloseEvent = {
      reason: "submit",
    };
    const snapshot: PluginLauncherRenderContextSnapshot = {
      environment: "hostOverlay",
      launcherId: "sync-modal",
      bounds: "default",
    };
    const runtimeContext: PluginRenderEnvironmentContext = {
      ...snapshot,
      requestModalBounds: async (_request) => undefined,
      closeLifecycle: null,
    };

    expect(JSONRPC_VERSION).toBe("2.0");
    expect(boundsRequest.bounds).toBe("wide");
    expect(closeEvent.reason).toBe("submit");
    expect(runtimeContext.launcherId).toBe("sync-modal");
  });

  it("delegates runtime ui exports through the global bridge registry", () => {
    const hookImpl = vi.fn(() => ({
      data: { ok: true },
      loading: false,
      error: null,
      refresh: vi.fn(),
    }));
    const metricImpl = vi.fn();
    const createElement = vi.fn((type, props) => ({ type, props }));

    (globalThis as typeof globalThis & {
      __paperclipPluginBridge__?: {
        react: { createElement: typeof createElement };
        sdkUi: Record<string, unknown>;
      };
    }).__paperclipPluginBridge__ = {
      react: { createElement },
      sdkUi: {
        usePluginData: hookImpl,
        MetricCard: metricImpl,
      },
    };

    const rootResult = rootUsePluginData("health", { companyId: "co-1" });
    const subpathResult = subpathUsePluginData("health", { companyId: "co-2" });

    expect(hookImpl).toHaveBeenNthCalledWith(1, "health", { companyId: "co-1" });
    expect(hookImpl).toHaveBeenNthCalledWith(2, "health", { companyId: "co-2" });
    expect(rootResult).toMatchObject({ data: { ok: true }, loading: false });
    expect(subpathResult).toMatchObject({ data: { ok: true }, loading: false });

    expect(RootMetricCard({ label: "Health", value: 1 })).toEqual({
      type: metricImpl,
      props: { label: "Health", value: 1 },
    });
    expect(SubpathMetricCard({ label: "Health", value: 2 })).toEqual({
      type: metricImpl,
      props: { label: "Health", value: 2 },
    });
  });
});
