import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.sidebar-modal-example";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Sidebar Modal (Example)",
  description: "Adds a sidebar entry that opens a modal when clicked.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: ["ui.sidebar.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    launchers: [
      {
        id: "open-modal",
        displayName: "Open modal",
        placementZone: "sidebar",
        action: {
          type: "openModal",
          target: "SidebarModalContent",
        },
        render: {
          environment: "hostOverlay",
          bounds: "default",
        },
      },
    ],
  },
};

export default manifest;
