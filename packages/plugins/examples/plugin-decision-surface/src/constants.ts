export const PLUGIN_ID = "paperclip.decision-surface";
export const PLUGIN_VERSION = "0.1.0";

export const TOOL_NAMES = {
  DECISIONS: "decisions",
  UNBLOCK_ISSUE: "unblock_issue",
} as const;

export const DATA_KEYS = {
  QUEUE: "queue",
} as const;

export const WIDGET_SLOT_ID = "decision-surface-dashboard-widget";
export const WIDGET_EXPORT_NAME = "DecisionSurfaceWidget";

export const PAGE_SLOT_ID = "decision-surface-page";
export const PAGE_EXPORT_NAME = "DecisionSurfacePage";
export const PAGE_ROUTE = "decisions";
