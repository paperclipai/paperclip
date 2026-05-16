import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "whitestag.pushover-watch",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Pushover Watch Notifications",
  description:
    "Sends Apple Watch notifications via Pushover for CEO-done tasks and board-wait states. Multi-company-aware via instance config.",
  author: "WHITESTAG",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issue.comments.read",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      pushoverUserKeyRef: {
        type: "string",
        title: "Pushover User Key (secret reference UUID)",
      },
      pushoverAppTokenRef: {
        type: "string",
        title: "Pushover App Token (secret reference UUID)",
      },
      boardUserId: {
        type: "string",
        title: "Board User ID",
        default: "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9",
      },
      clickbackBaseUrl: {
        type: "string",
        format: "uri",
        title: "Paperclip Web Base URL",
        default: "https://company.whitestag.ai",
      },
      dryRun: { type: "boolean", default: false },
      companies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            companyId: { type: "string", format: "uuid" },
            issuePrefix: { type: "string" },
            topAgentIds: { type: "array", items: { type: "string", format: "uuid" } },
            secretaryAgentIds: {
              type: "array",
              items: { type: "string", format: "uuid" },
              default: [],
            },
            enabled: { type: "boolean", default: true },
          },
          required: ["companyId", "issuePrefix", "topAgentIds"],
        },
        default: [
          {
            companyId: "9cebf3cf-efe8-4597-a400-f06488900a87",
            issuePrefix: "WHI",
            topAgentIds: ["506c873e-3a40-4483-9a45-0eb0fa1554bb"],
            secretaryAgentIds: ["e24b8d9d-143e-4141-b413-4361aa618771"],
            enabled: true,
          },
          {
            companyId: "158c4959-4973-4cb0-8066-55ec0f35625e",
            issuePrefix: "HEA",
            topAgentIds: ["6ddf2bfa-fe1c-4e26-a316-091b6ef3c182"],
            secretaryAgentIds: [],
            enabled: true,
          },
        ],
      },
    },
    required: ["pushoverUserKeyRef", "pushoverAppTokenRef", "boardUserId", "companies"],
  },
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
