import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip-file-browser-example";
const FILES_SIDEBAR_SLOT_ID = "files-link";
const FILES_TAB_SLOT_ID = "files-tab";
const COMMENT_FILE_LINKS_SLOT_ID = "comment-file-links";
const COMMENT_OPEN_FILES_SLOT_ID = "comment-open-files";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.5.0",
  displayName: "Explorador de Workspace",
  description: "Superfície operacional para navegar workspaces, editar arquivos e abrir referências vindas de comentários.",
  author: "Goldneuron",
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
        title: "Exibir workspace na lateral",
        default: false,
        description: "Adiciona o link de Workspace na barra lateral de cada projeto.",
      },
      commentAnnotationMode: {
        type: "string",
        title: "Integração com comentários",
        enum: ["annotation", "contextMenu", "both", "none"],
        default: "both",
        description: "Controla quais extensões de comentário ficam ativas: anotação, menu de contexto, ambas ou nenhuma.",
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
        displayName: "Workspace",
        exportName: "FilesLink",
        entityTypes: ["project"],
        order: 10,
      },
      {
        type: "detailTab",
        id: FILES_TAB_SLOT_ID,
        displayName: "Workspace",
        exportName: "FilesTab",
        entityTypes: ["project"],
        order: 10,
      },
      {
        type: "commentAnnotation",
        id: COMMENT_FILE_LINKS_SLOT_ID,
        displayName: "Referências de arquivo",
        exportName: "CommentFileLinks",
        entityTypes: ["comment"],
      },
      {
        type: "commentContextMenuItem",
        id: COMMENT_OPEN_FILES_SLOT_ID,
        displayName: "Abrir no workspace",
        exportName: "CommentOpenFiles",
        entityTypes: ["comment"],
      },
    ],
  },
};

export default manifest;
