import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { EXPORT_NAMES, PAGE_ROUTE, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Repos",
  description: "Browse and manage Darwin's code repositories. Shows all repos with status, open PRs, and deploy links.",
  author: "Darwin CTO",
  categories: ["ui", "workspace"],
  capabilities: [
    "ui.sidebar.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      githubTokenRef: {
        type: "string",
        title: "GitHub Token Secret Ref",
        description: "Paperclip secret ref for a GitHub personal access token (repo scope). Used to fetch live PR counts and commit dates. Optional — falls back to registry data only.",
        default: "",
      },
    },
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Repos",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Repos",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Repos",
        exportName: EXPORT_NAMES.sidebar,
      },
    ],
  },
};

export default manifest;
