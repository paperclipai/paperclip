import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Feedback Collection",
  description:
    "Normalizes Jira, Bitbucket, and Slack feedback into actionable Paperclip issues via tool calls or webhooks.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "issues.read",
    "issues.create",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "agent.tools.register",
    "webhooks.receive",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      defaultCompanyId: {
        type: "string",
        title: "Default Company ID",
        description: "Fallback company ID when no company is provided by tool run context or payload.",
      },
      defaultProjectId: {
        type: "string",
        title: "Default Project ID",
      },
      defaultGoalId: {
        type: "string",
        title: "Default Goal ID",
      },
      defaultParentId: {
        type: "string",
        title: "Default Parent Issue ID",
      },
      appendRawPayloadComment: {
        type: "boolean",
        title: "Append Raw Payload Comment",
        default: false,
      },
      webhookAuthSecretRef: {
        type: "string",
        title: "Webhook Auth Secret Ref",
        description:
          "Optional secret reference. If set, incoming webhooks must include header `x-feedback-token` equal to the resolved secret value.",
      },
    },
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.JIRA,
      displayName: "Jira Feedback Ingest",
      description: "Ingest Jira issue payloads as Paperclip issues.",
    },
    {
      endpointKey: WEBHOOK_KEYS.BITBUCKET,
      displayName: "Bitbucket Feedback Ingest",
      description: "Ingest Bitbucket PR/comment payloads as Paperclip issues.",
    },
    {
      endpointKey: WEBHOOK_KEYS.SLACK,
      displayName: "Slack Feedback Ingest",
      description: "Ingest Slack message payloads as Paperclip issues.",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.INGEST_FEEDBACK,
      displayName: "Ingest Feedback",
      description: "Normalize Jira/Bitbucket/Slack payloads and create a Paperclip issue.",
      parametersSchema: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["jira", "bitbucket", "slack"] },
          payload: { type: "object" },
          companyId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
          labels: {
            type: "array",
            items: { type: "string" },
          },
          projectId: { type: "string" },
          goalId: { type: "string" },
          parentId: { type: "string" },
          rawPayloadComment: { type: "boolean" },
        },
        required: ["source", "payload"],
      },
    },
  ],
};

export default manifest;
