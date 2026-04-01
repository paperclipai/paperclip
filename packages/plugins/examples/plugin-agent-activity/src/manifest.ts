import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  PAGE_EXPORT_NAME,
  PAGE_ROUTE,
  PAGE_SLOT_ID,
  PLUGIN_ID,
  PLUGIN_VERSION,
  WIDGET_EXPORT_NAME,
  WIDGET_SLOT_ID,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Agent Activity",
  description:
    "Clean, noise-free view of what each agent is doing right now. Strips injected context and surfaces only the meaningful work turns: tool calls, comments posted, and current task.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "issues.read",
    "companies.read",
    "agents.read",
    "plugin.state.read",
    "plugin.state.write",
    "agent.tools.register",
    "ui.action.register",
    "ui.dashboardWidget.register",
    "ui.page.register",
    "http.outbound",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: WIDGET_SLOT_ID,
        displayName: "Agent Activity",
        exportName: WIDGET_EXPORT_NAME,
      },
      {
        type: "page",
        id: PAGE_SLOT_ID,
        displayName: "Agent Activity",
        exportName: PAGE_EXPORT_NAME,
        routePath: PAGE_ROUTE,
      },
    ],
  },
};

export default manifest;
