import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.entity-tabs-example";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Entity Tabs (Example)",
  description: "Adds example tabs to Agent and Goal detail pages.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: ["ui.detailTab.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "detailTab",
        id: "agent-tab",
        displayName: "Plugin (Agent)",
        exportName: "AgentDetailTab",
        entityTypes: ["agent"],
      },
      {
        type: "detailTab",
        id: "goal-tab",
        displayName: "Plugin (Goal)",
        exportName: "GoalDetailTab",
        entityTypes: ["goal"],
      },
    ],
  },
};

export default manifest;
