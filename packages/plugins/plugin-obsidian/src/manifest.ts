import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, EXPORT_NAMES, JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Obsidian Vault Sync",
  description:
    "Unidirectional sync from Paperclip to an Obsidian vault. Exports issues and goals as Markdown notes with YAML frontmatter and wikilinks.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issue.comments.read",
    "goals.read",
    "agents.read",
    "events.subscribe",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "instance.settings.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      vaultPath: {
        type: "string",
        title: "Vault Path",
        description: "Absolute path to the local Obsidian vault directory. Leave empty if using a git remote.",
        default: DEFAULT_CONFIG.vaultPath,
      },
      gitRemoteUrl: {
        type: "string",
        title: "Git Remote URL",
        description:
          "Git remote URL for the vault repository (e.g. https://github.com/user/vault.git). Leave empty for local-only vaults.",
        default: DEFAULT_CONFIG.gitRemoteUrl,
      },
      gitBranch: {
        type: "string",
        title: "Git Branch",
        description: "Branch to sync to in the git remote.",
        default: DEFAULT_CONFIG.gitBranch,
      },
      syncEntities: {
        type: "array",
        title: "Entities to Sync",
        description: "Which Paperclip entities to export as Obsidian notes.",
        items: {
          type: "string",
          enum: ["issues", "goals"],
        },
        default: DEFAULT_CONFIG.syncEntities,
      },
      syncIntervalMinutes: {
        type: "number",
        title: "Sync Interval (minutes)",
        description: "How often to run the sync job.",
        default: DEFAULT_CONFIG.syncIntervalMinutes,
      },
      folderStructure: {
        type: "string",
        title: "Folder Structure",
        description:
          "How to organize notes: by-project groups notes under project folders, flat puts everything at the top level.",
        enum: ["by-project", "flat"],
        default: DEFAULT_CONFIG.folderStructure,
      },
      includeComments: {
        type: "boolean",
        title: "Include Comments",
        description: "Whether to include issue comments in the exported notes.",
        default: DEFAULT_CONFIG.includeComments,
      },
      maxCommentsPerIssue: {
        type: "number",
        title: "Max Comments per Issue",
        description: "Maximum number of comments to include per issue note (most recent first).",
        default: DEFAULT_CONFIG.maxCommentsPerIssue,
      },
    },
    required: [],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.sync,
      displayName: "Obsidian Vault Sync",
      description: "Exports changed Paperclip issues and goals as Markdown notes to the configured Obsidian vault.",
      schedule: "*/15 * * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Obsidian Sync Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Obsidian Sync",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
    ],
  },
};

export default manifest;
