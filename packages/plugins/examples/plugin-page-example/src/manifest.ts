import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.page-example";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Plugin Page (Example)",
  description: "Adds a company-context full page at /:companyPrefix/plugins/:pluginId.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: ["ui.page.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page",
        id: "main-page",
        displayName: "Plugin Page",
        exportName: "PluginPage",
      },
    ],
  },
};

export default manifest;
