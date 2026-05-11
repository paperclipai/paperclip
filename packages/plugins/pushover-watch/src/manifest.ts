import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-pushover-watch",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Plugin Pushover Watch",
  description: "A Paperclip plugin",
  author: "Plugin Author",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Plugin Pushover Watch Health",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
