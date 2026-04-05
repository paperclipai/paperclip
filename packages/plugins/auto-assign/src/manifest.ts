import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.auto-assign";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Auto-Assign (Emoji Prefix)",
  description:
    "Automatically assigns issues to agents based on emoji prefixes in the title. " +
    "Acts as a safety net when PM forgets to set assigneeAgentId.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issues.update",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      prefixMap: {
        type: "object",
        title: "Emoji Prefix → Agent ID Mapping",
        description:
          "Keys are emoji characters, values are agent UUIDs. " +
          'Example: { "🔧": "f3bd3061-..." }',
        additionalProperties: { type: "string" },
        default: {},
      },
    },
  },
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
