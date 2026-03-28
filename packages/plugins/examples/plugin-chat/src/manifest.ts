import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, EXPORT_NAMES, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Paperclip Chat",
  description: "Slide-out chatbot panel — talk directly to an OpenClaw agent",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "ui.sidebar.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      gatewayUrl: {
        type: "string",
        title: "OpenClaw Gateway URL",
        default: DEFAULT_CONFIG.gatewayUrl,
      },
      defaultAgentId: {
        type: "string",
        title: "Default Agent ID",
        default: "",
      },
      gatewayToken: {
        type: "string",
        title: "Gateway Token",
        default: "",
      },
    },
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Chat",
        exportName: EXPORT_NAMES.sidebar,
      },
      {
        type: "sidebarPanel",
        id: SLOT_IDS.sidebarPanel,
        displayName: "Chat Panel",
        exportName: EXPORT_NAMES.sidebarPanel,
      },
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Chat",
        exportName: EXPORT_NAMES.page,
        routePath: "chat",
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Chat Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
