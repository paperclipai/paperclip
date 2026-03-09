import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.main-tab-example";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Main Tab (Example)",
  description: "Adds an example tab to the Issue detail page in the main UI.",
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
        id: "main-tab",
        displayName: "Plugin",
        exportName: "IssueDetailTab",
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
