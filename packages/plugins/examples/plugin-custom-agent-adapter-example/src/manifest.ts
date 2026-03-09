import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.custom-agent-adapter-reference",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Custom Agent Adapter Reference (Example)",
  description: "Reference plugin that demonstrates how plugin APIs can complement a custom adapter extension package.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "events.subscribe",
    "events.emit",
    "agent.tools.register",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.write",
    "activity.log.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      adapterWebhookSecretRef: {
        type: "string",
        description: "Secret reference for a custom adapter service webhook endpoint."
      },
      adapterType: {
        type: "string",
        description: "The adapter type key this plugin coordinates with.",
        default: "my_custom_adapter"
      }
    },
    required: ["adapterWebhookSecretRef"]
  },
  tools: [
    {
      name: "run-custom-adapter-check",
      displayName: "Run Custom Adapter Check",
      description: "Pings a custom adapter service to validate runtime connectivity.",
      parametersSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" }
        },
        required: ["agentId"]
      }
    }
  ]
};

export default manifest;
