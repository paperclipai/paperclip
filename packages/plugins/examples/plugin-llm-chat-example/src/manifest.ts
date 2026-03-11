import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.llm-chat-example";
const CHAT_WIDGET_SLOT_ID = "llm-chat-widget";

/**
 * Manifest for the LLM Chat example plugin.
 *
 * This plugin demonstrates how to use ctx.llm to invoke a model adapter
 * directly from a plugin worker, stream chunks to the UI via ctx.streams,
 * and display a simple chat interface in a dashboard widget.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "LLM Chat (Example)",
  description:
    "Reference plugin that demonstrates ctx.llm — direct adapter invocation, multi-turn session continuity, and streamed responses in a dashboard widget.",
  author: "Paperclip",
  categories: ["ui", "workspace"],
  capabilities: [
    "ui.dashboardWidget.register",
    "llm.providers.list",
    "llm.sessions.create",
    "llm.sessions.send",
    "llm.sessions.close",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: CHAT_WIDGET_SLOT_ID,
        displayName: "LLM Chat",
        exportName: "LlmChatWidget",
      },
    ],
  },
};

export default manifest;
