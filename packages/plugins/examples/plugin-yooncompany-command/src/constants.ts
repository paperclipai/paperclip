export const PLUGIN_ID = "yooncompany-command";
export const PLUGIN_VERSION = "0.1.0";

export const SLOT_IDS = {
  dashboardWidget: "yooncompany-command-dashboard-widget",
  sidebarPanel: "yooncompany-command-sidebar-panel",
} as const;

export const EXPORT_NAMES = {
  dashboardWidget: "YoonCompanyCommandWidget",
  sidebarPanel: "YoonCompanyQuickActionsPanel",
} as const;

export const ACTION_KEYS = {
  createGuidedIssue: "create-guided-issue",
} as const;

export type GuidedIssueKind = "ask_codex" | "ask_hermes" | "new_task";
