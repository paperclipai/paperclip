import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-human-org";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "human-org";

export const SLOT_IDS = {
  page: "human-org-page",
  sidebar: "human-org-sidebar",
  taskDetail: "human-org-task-detail",
} as const;

export const EXPORT_NAMES = {
  page: "HumanOrgPage",
  sidebar: "HumanOrgSidebarLink",
  taskDetail: "HumanTaskDetailView",
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Human Org & Work",
  description: "Import a human org chart with capabilities and responsibilities, assign Paperclip issues, track human work on a Kanban board, and notify people in Mattermost.",
  author: "Paperclip",
  categories: ["automation", "connector", "ui"],
  capabilities: [
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "access.members.read",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      mattermostWebhook: {
        type: "string",
        format: "secret-ref",
        title: "Mattermost incoming webhook",
        description: "Store the full incoming-webhook URL as a Paperclip Secret. The resolved URL is never written to plugin data or logs.",
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip company URL",
        description: "Base URL used in Mattermost task links, for example https://paperclip.example/RCM",
      },
      notifyMattermost: {
        type: "boolean",
        title: "Notify Mattermost on assignment",
        default: true,
      },
    },
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Human Org & Work",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Human Org & Work",
        exportName: EXPORT_NAMES.sidebar,
      },
      {
        type: "taskDetailView",
        id: SLOT_IDS.taskDetail,
        displayName: "Human assignment",
        exportName: EXPORT_NAMES.taskDetail,
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
