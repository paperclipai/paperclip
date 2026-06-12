import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Stable plugin ID used by host registration and namespacing.
 */
const PLUGIN_ID = "paperclip.i18n-overlay";
const PLUGIN_VERSION = "0.1.0";
const SIDEBAR_SLOT_ID = "i18n-overlay-mount";
const SIDEBAR_EXPORT_NAME = "I18nOverlayMount";

/**
 * UI-only plugin that mounts an invisible sidebar component which starts the
 * client-side GUI translation engine (German seed dictionary).
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GUI-Übersetzung (DE)",
  description:
    "Übersetzt die Paperclip-Oberfläche über austauschbare JSON-Sprachdateien (deutscher Seed).",
  author: "WHITESTAG",
  categories: ["ui"],
  capabilities: ["ui.sidebar.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: SIDEBAR_SLOT_ID,
        displayName: "GUI-Übersetzung",
        exportName: SIDEBAR_EXPORT_NAME,
      },
    ],
  },
};

export default manifest;
