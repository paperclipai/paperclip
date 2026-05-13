import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-i18n-pt-br",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Português (Brasil)",
  description: "Language pack adding support for Brazilian Portuguese.",
  author: "jvkabum",
  categories: ["ui"],
  capabilities: [],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "i18n-pt-br-provider",
        displayName: "Português (Brasil)",
        exportName: "TranslationProvider",
        order: 100
      }
    ]
  }
};

export default manifest;
