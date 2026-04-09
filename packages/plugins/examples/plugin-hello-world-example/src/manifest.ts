import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Stable plugin ID used by host registration and namespacing.
 */
const PLUGIN_ID = "paperclip.hello-world-example";
const PLUGIN_VERSION = "0.2.0";
const DASHBOARD_WIDGET_SLOT_ID = "hello-world-dashboard-widget";
const DASHBOARD_WIDGET_EXPORT_NAME = "HelloWorldDashboardWidget";

/**
 * Minimal manifest demonstrating a UI-only plugin with one dashboard widget slot.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Company Pulse",
  description: "Dashboard widget that summarizes the current company workload, active agents, and goals at a glance.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [
    "ui.dashboardWidget.register",
    "projects.read",
    "issues.read",
    "agents.read",
    "goals.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: DASHBOARD_WIDGET_SLOT_ID,
        displayName: "Company Pulse",
        exportName: DASHBOARD_WIDGET_EXPORT_NAME,
      },
    ],
  },
};

export default manifest;
