import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Stable plugin ID used by host registration and namespacing.
 */
const PLUGIN_ID = "paperclip.hello-world-example";
const PLUGIN_VERSION = "0.4.0";
const DASHBOARD_WIDGET_SLOT_ID = "hello-world-dashboard-widget";
const DASHBOARD_WIDGET_EXPORT_NAME = "HelloWorldDashboardWidget";

/**
 * Manifest do widget first-party que resume a situação operacional da empresa.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Pulso da Empresa",
  description: "Widget operacional que resume a carga atual da empresa, issues abertas, metas e agentes ativos.",
  author: "Goldneuron",
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
        displayName: "Pulso da Empresa",
        exportName: DASHBOARD_WIDGET_EXPORT_NAME,
      },
    ],
  },
};

export default manifest;
