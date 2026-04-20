import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.google-drive-context-example",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Google Drive Context (Example)",
  description: "Syncs configured Google Drive folders into Paperclip project context sources.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "project.context.read",
    "project.context.write",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["googleCredentialSecretRef", "targets"],
    properties: {
      googleCredentialSecretRef: {
        type: "string",
        format: "secret-ref",
        title: "Google Credential Secret",
        description: "Company secret containing either a raw Google OAuth access token or JSON with client_id, client_secret, and refresh_token.",
      },
      maxFilesPerTarget: {
        type: "number",
        title: "Max Files Per Target",
        default: 50,
        minimum: 1,
        maximum: 500,
      },
      targets: {
        type: "array",
        title: "Linked Google Drive Targets",
        description: "Individual Google Docs/Sheets/Slides/file links or Drive folder links to sync into project context.",
        minItems: 1,
        items: {
          type: "object",
          required: ["companyId", "projectId", "urlOrId"],
          properties: {
            companyId: { type: "string", title: "Company ID", minLength: 1 },
            projectId: { type: "string", title: "Project ID", minLength: 1 },
            urlOrId: { type: "string", title: "Drive URL or ID", minLength: 1 },
            title: { type: "string", title: "Display Name" },
          },
        },
        default: [],
      },
    },
  },
  jobs: [
    {
      jobKey: "sync-drive-folders",
      displayName: "Sync Drive Folders",
      description: "Refresh configured Google Drive project context sources.",
      schedule: "0 * * * *",
    },
  ],
};

export default manifest;
