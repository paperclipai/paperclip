import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "hlt.katailyst-learner";
export const PLUGIN_VERSION = "0.1.0";
export const RUN_COMPLETE_EVENT = "agent.run.finished";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Katailyst Learner",
  description: "Sends successful Paperclip run-complete events to Katailyst Hermes Learner.",
  author: "HLT",
  categories: ["automation", "connector"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        title: "Enabled",
        default: true,
      },
      endpointUrl: {
        type: "string",
        title: "Katailyst learner endpoint URL",
        description: "Katailyst endpoint that receives Paperclip run-complete events.",
      },
      secretRef: {
        type: "string",
        title: "Webhook secret reference",
        format: "secret-ref",
        description: "Paperclip secret reference whose value matches HERMES_LEARNER_WEBHOOK_SECRET in Katailyst.",
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip base URL",
        description: "Optional base URL used to include a human-readable run link in the learner payload.",
      },
    },
    required: ["endpointUrl", "secretRef"],
  },
};

export default manifest;
