import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip-file-browser-example";
const FILES_SIDEBAR_SLOT_ID = "files-link";
const FILES_TAB_SLOT_ID = "files-tab";
const COMMENT_FILE_LINKS_SLOT_ID = "comment-file-links";
const COMMENT_OPEN_FILES_SLOT_ID = "comment-open-files";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.2.0",
  displayName: "File Browser (Example)",
  description: "Example plugin that adds a Files link under each project in the sidebar, a file browser + editor tab on the project detail page, and per-comment file link annotations with a context menu action to open referenced files.",
  author: "Paperclip",
  categories: ["workspace", "ui"],
  capabilities: [
    "ui.sidebar.register",
    "ui.detailTab.register",
    "ui.commentAnnotation.register",
    "ui.action.register",
    "projects.read",
    "project.workspaces.read",
    "issue.comments.read",
    "plugin.state.read",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      showFilesInSidebar: {
        type: "boolean",
        title: "Show Files in Sidebar",
        default: false,
        description: "Adds the Files link under each project in the sidebar.",
      },
      commentAnnotationMode: {
        type: "string",
        title: "Comment File Links",
        enum: ["annotation", "contextMenu", "both", "none"],
        default: "both",
        description: "Controls which comment extensions are active: 'annotation' shows file links below each comment, 'contextMenu' adds an \"Open in Files\" action to the comment menu, 'both' enables both, 'none' disables comment features.",
      },
    },
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "projectSidebarItem",
        id: FILES_SIDEBAR_SLOT_ID,
        displayName: "Files",
        exportName: "FilesLink",
        entityTypes: ["project"],
        order: 10,
      },
      {
        type: "detailTab",
        id: FILES_TAB_SLOT_ID,
        displayName: "Files",
        exportName: "FilesTab",
        entityTypes: ["project"],
        order: 10,
      },
      {
        type: "commentAnnotation",
        id: COMMENT_FILE_LINKS_SLOT_ID,
        displayName: "File Links",
        exportName: "CommentFileLinks",
        entityTypes: ["comment"],
      },
      {
        type: "commentContextMenuItem",
        id: COMMENT_OPEN_FILES_SLOT_ID,
        displayName: "Open in Files",
        exportName: "CommentOpenFiles",
        entityTypes: ["comment"],
      },
    ],
  },
};

export default manifest;
