import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { EXPORT_NAMES, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "YoonCompany 운영",
  description: "Paperclip에서 Codex, Hermes, 승인, 위험, 비용, 진화 작업을 운영하기 위한 명령 패널과 빠른 실행입니다.",
  author: "YoonCompany",
  categories: ["ui", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "issue.comments.create",
    "agents.read",
    "ui.dashboardWidget.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "YoonCompany 운영 현황",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "sidebarPanel",
        id: SLOT_IDS.sidebarPanel,
        displayName: "YoonCompany 빠른 실행",
        exportName: EXPORT_NAMES.sidebarPanel,
      },
    ],
  },
};

export default manifest;
