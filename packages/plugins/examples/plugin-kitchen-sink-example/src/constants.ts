import type { PluginLauncherRegistration } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip-kitchen-sink-example";
export const PLUGIN_DISPLAY_NAME = "Central de Operações";
export const PLUGIN_VERSION = "0.4.0";
export const PAGE_ROUTE = "central-operacoes";

export const SLOT_IDS = {
  page: "kitchen-sink-page",
  settingsPage: "kitchen-sink-settings-page",
  dashboardWidget: "kitchen-sink-dashboard-widget",
  sidebar: "kitchen-sink-sidebar-link",
  sidebarPanel: "kitchen-sink-sidebar-panel",
  projectSidebarItem: "kitchen-sink-project-link",
  projectTab: "kitchen-sink-project-tab",
  issueTab: "kitchen-sink-issue-tab",
  taskDetailView: "kitchen-sink-task-detail",
  toolbarButton: "kitchen-sink-toolbar-action",
  contextMenuItem: "kitchen-sink-context-action",
  commentAnnotation: "kitchen-sink-comment-annotation",
  commentContextMenuItem: "kitchen-sink-comment-action",
} as const;

export const EXPORT_NAMES = {
  page: "KitchenSinkPage",
  settingsPage: "KitchenSinkSettingsPage",
  dashboardWidget: "KitchenSinkDashboardWidget",
  sidebar: "KitchenSinkSidebarLink",
  sidebarPanel: "KitchenSinkSidebarPanel",
  projectSidebarItem: "KitchenSinkProjectSidebarItem",
  projectTab: "KitchenSinkProjectTab",
  issueTab: "KitchenSinkIssueTab",
  taskDetailView: "KitchenSinkTaskDetailView",
  toolbarButton: "KitchenSinkToolbarButton",
  contextMenuItem: "KitchenSinkContextMenuItem",
  commentAnnotation: "KitchenSinkCommentAnnotation",
  commentContextMenuItem: "KitchenSinkCommentContextMenuItem",
  launcherModal: "KitchenSinkLauncherModal",
} as const;

export const JOB_KEYS = {
  heartbeat: "ops-heartbeat",
} as const;

export const WEBHOOK_KEYS = {
  demo: "incident-ingest",
} as const;

export const TOOL_NAMES = {
  echo: "echo",
  companySummary: "company-summary",
  createIssue: "create-issue",
} as const;

export const STREAM_CHANNELS = {
  progress: "progress",
  agentChat: "agent-chat",
} as const;

export const SAFE_COMMANDS = [
  {
    key: "pwd",
    label: "Mostrar caminho do workspace",
    command: "pwd",
    args: [] as string[],
    description: "Mostra o diretório atual do workspace.",
  },
  {
    key: "ls",
    label: "Listar arquivos do workspace",
    command: "ls",
    args: ["-la"] as string[],
    description: "Lista os arquivos do workspace selecionado.",
  },
  {
    key: "git-status",
    label: "Status do Git",
    command: "git",
    args: ["status", "--short", "--branch"] as string[],
    description: "Mostra o status do Git no workspace selecionado.",
  },
] as const;

export type SafeCommandKey = (typeof SAFE_COMMANDS)[number]["key"];

export const DEFAULT_CONFIG = {
  showSidebarEntry: true,
  showSidebarPanel: true,
  showProjectSidebarItem: true,
  showCommentAnnotation: true,
  showCommentContextMenuItem: true,
  enableWorkspaceDemos: true,
  enableProcessDemos: false,
  secretRefExample: "",
  httpDemoUrl: "https://httpbin.org/anything",
  allowedCommands: SAFE_COMMANDS.map((command) => command.key),
  workspaceScratchFile: ".paperclip-central-operacoes.txt",
} as const;

export const RUNTIME_LAUNCHER: PluginLauncherRegistration = {
  id: "central-operacoes-runtime-launcher",
  displayName: "Modal da Central de Operações",
  description: "Overlay operacional rápido registrado pelo runtime do worker.",
  placementZone: "toolbarButton",
  entityTypes: ["project", "issue"],
  action: {
    type: "openModal",
    target: EXPORT_NAMES.launcherModal,
  },
  render: {
    environment: "hostOverlay",
    bounds: "wide",
  },
};
