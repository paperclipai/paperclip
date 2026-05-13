import type { OdysseusPluginManifestV1 } from "@odysseus/plugin-sdk";

/**
 * Stable plugin ID used by host registration and namespacing.
 */
const PLUGIN_ID = "odysseus.hello-world-example";
const PLUGIN_VERSION = "0.1.0";
const DASHBOARD_WIDGET_SLOT_ID = "hello-world-dashboard-widget";
const DASHBOARD_WIDGET_EXPORT_NAME = "HelloWorldDashboardWidget";

/**
 * Minimal manifest demonstrating a UI-only plugin with one dashboard widget slot.
 */
const manifest: OdysseusPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Hello World Widget (Example)",
  description: "Reference UI plugin that adds a simple Hello World widget to the Odysseus dashboard.",
  author: "Odysseus",
  categories: ["ui"],
  capabilities: ["ui.dashboardWidget.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: DASHBOARD_WIDGET_SLOT_ID,
        displayName: "Hello World",
        exportName: DASHBOARD_WIDGET_EXPORT_NAME,
      },
    ],
  },
};

export default manifest;
