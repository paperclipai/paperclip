import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION, SIDEBAR_PANEL_SLOT_ID } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Mobile Viewport Guard",
  description:
    "Installs a small same-origin UI guard that keeps Paperclip usable on mobile Safari by preventing page zoom, horizontal viewport drift, and selector keyboard occlusion.",
  author: "PaperclipAI",
  categories: ["ui"],
  capabilities: ["ui.sidebar.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "sidebarPanel",
        id: SIDEBAR_PANEL_SLOT_ID,
        displayName: "Mobile viewport guard",
        exportName: "MobileViewportGuardSidebarPanel",
        order: 10_000,
      },
    ],
  },
};

export default manifest;
