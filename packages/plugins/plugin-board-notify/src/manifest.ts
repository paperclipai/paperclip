import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.board-notify";
export const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Board Notifications",
  description:
    "Sends email notifications via Resend when issues are assigned to board users, or when agents request board action.",
  author: "Diger Studios",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "secrets.read-ref",
    "http.outbound",
    "issues.read",
    "issue.comments.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      resendApiKeyRef: {
        type: "string",
        title: "Resend API Key",
        description: "Secret reference (UUID) for the Resend API key",
        format: "secret-ref",
        default: "",
      },
      fromAddress: {
        type: "string",
        title: "From Address",
        description: "Email sender address (must be verified in Resend)",
        default: "paperclip@notify.digerstudios.com",
      },
      toAddress: {
        type: "string",
        title: "To Address",
        description: "Board user email to notify",
        default: "rudy@digerstudios.com",
      },
      notifyOnAssign: {
        type: "boolean",
        title: "Notify on issue assignment",
        description: "Send email when an issue is assigned to a board user",
        default: true,
      },
      notifyOnBlocked: {
        type: "boolean",
        title: "Notify on blocked (board action needed)",
        description: "Send email when an issue is marked blocked and the latest comment mentions board action",
        default: true,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Base URL",
        description: "Base URL for links in emails (e.g. https://wyvern-jig.exe.xyz:3100)",
        default: "",
      },
    },
    required: ["resendApiKeyRef", "fromAddress", "toAddress"],
  },
};

export default manifest;
