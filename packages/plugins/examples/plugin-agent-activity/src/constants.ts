export const PLUGIN_ID = "paperclip.agent-activity";
export const PLUGIN_VERSION = "0.1.0";

export const TOOL_NAMES = {
  AGENT_STATUS: "agent_status",
  RUN_SUMMARY: "run_summary",
} as const;

export const DATA_KEYS = {
  LIVE: "live",
} as const;

export const WIDGET_SLOT_ID = "agent-activity-dashboard-widget";
export const WIDGET_EXPORT_NAME = "AgentActivityWidget";

export const PAGE_SLOT_ID = "agent-activity-page";
export const PAGE_EXPORT_NAME = "AgentActivityPage";
export const PAGE_ROUTE = "agent-activity";
