import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.i18n-example";
const PLUGIN_VERSION = "0.1.0";

/**
 * Example manifest demonstrating plugin i18n with usePluginTranslation().
 *
 * This plugin ships locale files under dist/ui/locales/{lang}/messages.json
 * and uses the usePluginTranslation() hook to translate its dashboard widget.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "i18n Example Widget",
  description: "Reference plugin demonstrating usePluginTranslation() for multilingual plugin UI.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: ["ui.dashboardWidget.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  locales: [
    {
      languageCode: "en",
      namespaces: ["messages"],
    },
    {
      languageCode: "ko",
      namespaces: ["messages"],
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "i18n-example-widget",
        displayName: "i18n Example",
        exportName: "I18nExampleWidget",
      },
    ],
  },
};

export default manifest;
