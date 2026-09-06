import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Stable plugin ID. Used by host registration and event namespacing.
 */
export const PLUGIN_ID = "paperclip.hdo-76-pixel-strip";

/**
 * Slot IDs are stable identifiers; renaming them is a breaking change.
 */
const PIXEL_STRIP_TAB_SLOT_ID = "pixel-strip-tab";
const PIXEL_STRIP_SIDEBAR_SLOT_ID = "pixel-strip-link";
const PIXEL_STRIP_TAB_EXPORT_NAME = "PixelStripTab";
const PIXEL_STRIP_SIDEBAR_EXPORT_NAME = "PixelStripLink";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "HDO-76 Pixel Strip (Prototype)",
  description:
    "Read-only project-detail pixel-agent strip. Maps persisted Paperclip runtime state onto the archived HuiDots Pixel-Company visual authority. No animation that implies work, no write-back, no timer-derived activity.",
  author: "HuiDots CTO (HDO-76)",
  categories: ["ui"],
  // Read-only capability surface. The plugin never requests any
  // `*.create`, `*.update`, `*.write`, or `*.delete` capability.
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "agents.read",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "ui.detailTab.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "detailTab",
        id: PIXEL_STRIP_TAB_SLOT_ID,
        displayName: "Pixel Strip",
        exportName: PIXEL_STRIP_TAB_EXPORT_NAME,
        entityTypes: ["project"],
        order: 20,
      },
      {
        type: "projectSidebarItem",
        id: PIXEL_STRIP_SIDEBAR_SLOT_ID,
        displayName: "Pixel Strip",
        exportName: PIXEL_STRIP_SIDEBAR_EXPORT_NAME,
        entityTypes: ["project"],
        order: 20,
      },
    ],
  },
};

export default manifest;
