import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "rende.decision-status-widget";
const PLUGIN_VERSION = "1.0.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Entscheidungs-Dashboard Widget",
  description: "Zeigt ausstehende Approvals, Interactions und In-Review Issues zentral im Dashboard. Reduziert übersehene Entscheidungsaufforderungen.",
  author: "Rende Gerüstbau sarl",
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
        id: "decision-status-widget",
        displayName: "Ausstehende Entscheidungen",
        exportName: "DecisionStatusWidget",
        order: 1,
      },
    ],
  },
};

export default manifest;
