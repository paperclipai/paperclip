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
  displayName: "Decision Surface",
  description:
    "Surfaces pending approvals and blocked issues in one actionable view. Provides a decisions tool for agents and auto-unblocks issues when approvals are resolved.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issues.update",
    "issue.comments.create",
    "companies.read",
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
        displayName: "Decision Queue",
        exportName: WIDGET_EXPORT_NAME,
      },
      {
        type: "page",
        id: PAGE_SLOT_ID,
        displayName: "Decisions",
        exportName: PAGE_EXPORT_NAME,
        routePath: PAGE_ROUTE,
      },
    ],
  },
};

export default manifest;
