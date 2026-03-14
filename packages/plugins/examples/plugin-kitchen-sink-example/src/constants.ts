import type { PluginLauncherRegistration } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip-kitchen-sink-example";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "kitchensink";

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
  heartbeat: "demo-heartbeat",
} as const;

export const WEBHOOK_KEYS = {
  demo: "demo-ingest",
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
    label: "Print workspace path",
    command: "pwd",
    args: [] as string[],
    description: "Prints the current workspace directory.",
  },
  {
    key: "ls",
    label: "List workspace files",
    command: "ls",
    args: ["-la"] as string[],
    description: "Lists files in the selected workspace.",
  },
  {
    key: "git-status",
    label: "Git status",
    command: "git",
    args: ["status", "--short", "--branch"] as string[],
    description: "Shows git status for the selected workspace.",
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
  workspaceScratchFile: ".paperclip-kitchen-sink-demo.txt",
} as const;

export const RUNTIME_LAUNCHER: PluginLauncherRegistration = {
  id: "kitchen-sink-runtime-launcher",
  displayName: "Kitchen Sink Modal",
  description: "Demonstrates runtime launcher registration from the worker.",
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
