/**
 * Plugin bridge initialization.
 *
 * Registers the host's React instances and bridge hook implementations
 * on a global object so that the plugin module loader can inject them
 * into plugin UI bundles at load time.
 *
 * Call `initPluginBridge()` once during app startup (in `main.tsx`), before
 * any plugin UI modules are loaded.
 *
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §19.0.2 — Bundle Isolation
 */

import type { ReactNode } from "react";
import {
  usePluginData,
  usePluginAction,
  useHostContext,
} from "./bridge.js";

// ---------------------------------------------------------------------------
// Global bridge registry
// ---------------------------------------------------------------------------

/**
 * The global bridge registry shape.
 *
 * This is placed on `globalThis.__paperclipPluginBridge__` and consumed by
 * the plugin module loader to provide implementations for external imports.
 */
export interface PluginBridgeRegistry {
  react: unknown;
  reactDom: unknown;
  sdkUi: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __paperclipPluginBridge__: PluginBridgeRegistry | undefined;
}

/**
 * Initialize the plugin bridge global registry.
 *
 * Registers the host's React, ReactDOM, and SDK UI bridge implementations
 * on `globalThis.__paperclipPluginBridge__` so the plugin module loader
 * can provide them to plugin bundles.
 *
 * @param react - The host's React module
 * @param reactDom - The host's ReactDOM module
 */
export function initPluginBridge(
  react: typeof import("react"),
  reactDom: typeof import("react-dom"),
): void {
  globalThis.__paperclipPluginBridge__ = {
    react,
    reactDom,
    sdkUi: {
      // Bridge hooks
      usePluginData,
      usePluginAction,
      useHostContext,

      // Placeholder shared UI components — plugins that use these will get
      // functional stubs. Full implementations matching the host's design
      // system can be added later.
      MetricCard: createStubComponent("MetricCard"),
      StatusBadge: createStubComponent("StatusBadge"),
      DataTable: createStubComponent("DataTable"),
      TimeseriesChart: createStubComponent("TimeseriesChart"),
      MarkdownBlock: createStubComponent("MarkdownBlock"),
      KeyValueList: createStubComponent("KeyValueList"),
      ActionBar: createStubComponent("ActionBar"),
      LogView: createStubComponent("LogView"),
      JsonTree: createStubComponent("JsonTree"),
      Spinner: createStubComponent("Spinner"),
      ErrorBoundary: createPassthroughComponent("ErrorBoundary"),
    },
  };
}

// ---------------------------------------------------------------------------
// Stub component helpers
// ---------------------------------------------------------------------------

function createStubComponent(name: string): unknown {
  const fn = (props: Record<string, unknown>) => {
    // Import React from the registry to avoid import issues
    const React = globalThis.__paperclipPluginBridge__?.react as typeof import("react") | undefined;
    if (!React) return null;
    return React.createElement("div", {
      "data-plugin-component": name,
      style: {
        padding: "8px",
        border: "1px dashed #666",
        borderRadius: "4px",
        fontSize: "12px",
        color: "#888",
      },
    }, `[${name}]`);
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

function createPassthroughComponent(name: string): unknown {
  const fn = (props: { children?: ReactNode }) => {
    const ReactLib = globalThis.__paperclipPluginBridge__?.react as typeof import("react") | undefined;
    if (!ReactLib) return null;
    return ReactLib.createElement(ReactLib.Fragment, null, props.children);
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}
