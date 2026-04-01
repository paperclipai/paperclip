export const PLUGIN_ID = "valctrl.github-kpi";
export const PLUGIN_VERSION = "0.2.0";
export const PAGE_ROUTE = "github-kpi";

export const SLOT_IDS = {
  dashboardWidget: "github-kpi-dashboard-widget",
  page: "github-kpi-page",
  sidebar: "github-kpi-sidebar-link",
} as const;

export const EXPORT_NAMES = {
  dashboardWidget: "GitHubKpiDashboardWidget",
  page: "GitHubKpiPage",
  sidebar: "GitHubKpiSidebarLink",
} as const;

export const JOB_KEYS = {
  sync: "github-sync",
} as const;

export const WEBHOOK_KEYS = {
  events: "github-events",
} as const;

export const TOOL_NAMES = {
  stats: "github-stats",
  prList: "github-pr-list",
} as const;

export const DEFAULT_CONFIG = {
  orgName: "",
  githubTokenRef: "",
  repoFilter: [] as string[],
  repoExclude: [] as string[],
} as const;
