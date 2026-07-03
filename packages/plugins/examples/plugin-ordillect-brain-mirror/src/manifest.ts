import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "ordillect.brain-mirror";
export const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Ordillect Brain Mirror",
  description:
    "Mirrors every Paperclip issue comment into a per-issue Honcho session in the ordillect-brain workspace (AGE-101).",
  author: "Ordillect",
  categories: ["automation", "connector"],
  capabilities: [
    "issues.read",
    "issue.comments.read",
    "agents.read",
    "events.subscribe",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["honchoBaseUrl"],
    properties: {
      honchoBaseUrl: {
        type: "string",
        title: "Honcho base URL",
        description:
          "Base URL of the Honcho API. On the Ordillect Hetzner host this is http://agentic-honcho-api:8000.",
        default: "http://agentic-honcho-api:8000",
      },
      honchoWorkspace: {
        type: "string",
        title: "Honcho workspace id",
        default: "ordillect-brain",
      },
      honchoApiToken: {
        type: "string",
        title: "Honcho bearer token (optional)",
        description:
          "Sent as Authorization: Bearer <token>. Leave blank on the internal Docker network where USE_AUTH=false.",
      },
    },
  },
};

export default manifest;
