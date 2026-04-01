export const PLUGIN_ID = "valctrl.linear";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "linear";

export const SLOT_IDS = {
  dashboardWidget: "linear-dashboard-widget",
  page: "linear-page",
} as const;

export const EXPORT_NAMES = {
  dashboardWidget: "LinearDashboardWidget",
  page: "LinearPage",
} as const;

export const JOB_KEYS = {
  sync: "linear-sync",
} as const;

export const WEBHOOK_KEYS = {
  events: "linear-events",
} as const;

export const TOOL_NAMES = {
  stats: "linear-stats",
  issueList: "linear-issue-list",
} as const;

export const DEFAULT_CONFIG = {
  linearApiKeyRef: "",
  teamFilter: [] as string[],
} as const;
