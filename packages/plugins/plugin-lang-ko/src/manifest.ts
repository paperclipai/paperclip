import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Korean language pack plugin.
 *
 * Locale-only plugin — no worker, no capabilities, no UI slots.
 * Provides KO translations for all 15 Core namespaces.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.lang-ko",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Korean Language Pack (한국어)",
  description: "Provides Korean (한국어) translations for the Paperclip UI.",
  author: "Paperclip Contributors",
  categories: ["ui"],
  capabilities: [],
  entrypoints: {
    ui: "./dist/ui",
  },
  locales: [
    {
      languageCode: "ko",
      namespaces: [
        "common", "agents", "costs", "inbox", "dashboard",
        "issues", "projects", "goals", "approvals", "routines",
        "settings", "onboarding", "skills", "workspaces", "plugins",
      ],
    },
  ],
};

export default manifest;
