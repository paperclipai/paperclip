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
    properties: {
      accessTokenSecretRef: {
        type: "string",
        title: "Google OAuth Access Token Secret Ref",
      },
      maxFilesPerFolder: {
        type: "number",
        title: "Max Files Per Folder",
        default: 50,
      },
      folders: {
        type: "array",
        title: "Linked Folders",
        items: {
          type: "object",
          required: ["companyId", "projectId", "folderId"],
          properties: {
            companyId: { type: "string", title: "Company ID" },
            projectId: { type: "string", title: "Project ID" },
            folderId: { type: "string", title: "Folder ID or URL" },
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
