import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  ROUTES,
  SLOT_IDS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "app1n Views",
  description: "Views MeisnerDan para o cockpit app1n: brain-dump, inbox, eisenhower, autopilot e priority-matrix.",
  author: "app1n",
  categories: ["ui", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "agents.read",
    "plugin.state.read",
    "plugin.state.write",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.brainDumpPage,
        displayName: "Brain Dump",
        exportName: EXPORT_NAMES.brainDumpPage,
        routePath: ROUTES.brainDump,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.brainDumpSidebar,
        displayName: "Brain Dump",
        exportName: EXPORT_NAMES.brainDumpSidebar,
      },
      {
        type: "page",
        id: SLOT_IDS.inboxPage,
        displayName: "app1n Inbox",
        exportName: EXPORT_NAMES.inboxPage,
        routePath: ROUTES.inbox,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.inboxSidebar,
        displayName: "app1n Inbox",
        exportName: EXPORT_NAMES.inboxSidebar,
      },
      {
        type: "page",
        id: SLOT_IDS.eisenhowerPage,
        displayName: "Eisenhower",
        exportName: EXPORT_NAMES.eisenhowerPage,
        routePath: ROUTES.eisenhower,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.eisenhowerSidebar,
        displayName: "Eisenhower",
        exportName: EXPORT_NAMES.eisenhowerSidebar,
      },
      {
        type: "page",
        id: SLOT_IDS.autopilotPage,
        displayName: "Autopilot",
        exportName: EXPORT_NAMES.autopilotPage,
        routePath: ROUTES.autopilot,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.autopilotSidebar,
        displayName: "Autopilot",
        exportName: EXPORT_NAMES.autopilotSidebar,
      },
      {
        type: "page",
        id: SLOT_IDS.priorityMatrixPage,
        displayName: "Priority Matrix",
        exportName: EXPORT_NAMES.priorityMatrixPage,
        routePath: ROUTES.priorityMatrix,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.priorityMatrixSidebar,
        displayName: "Priority Matrix",
        exportName: EXPORT_NAMES.priorityMatrixSidebar,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "app1n Status",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
    ],
  },
};

export default manifest;
