export const PLUGIN_ID = "app1n.plugin-views";
export const PLUGIN_VERSION = "0.1.0";

export const ROUTES = {
  brainDump: "app1n-brain-dump",
  inbox: "app1n-inbox",
  eisenhower: "app1n-eisenhower",
  autopilot: "app1n-autopilot",
  priorityMatrix: "app1n-priority-matrix",
} as const;

export const SLOT_IDS = {
  brainDumpPage: "app1n-brain-dump-page",
  brainDumpSidebar: "app1n-brain-dump-sidebar",
  inboxPage: "app1n-inbox-page",
  inboxSidebar: "app1n-inbox-sidebar",
  eisenhowerPage: "app1n-eisenhower-page",
  eisenhowerSidebar: "app1n-eisenhower-sidebar",
  autopilotPage: "app1n-autopilot-page",
  autopilotSidebar: "app1n-autopilot-sidebar",
  priorityMatrixPage: "app1n-priority-matrix-page",
  priorityMatrixSidebar: "app1n-priority-matrix-sidebar",
  dashboardWidget: "app1n-views-dashboard-widget",
} as const;

export const EXPORT_NAMES = {
  brainDumpPage: "BrainDumpPage",
  brainDumpSidebar: "BrainDumpSidebarLink",
  inboxPage: "InboxPage",
  inboxSidebar: "InboxSidebarLink",
  eisenhowerPage: "EisenhowerPage",
  eisenhowerSidebar: "EisenhowerSidebarLink",
  autopilotPage: "AutopilotPage",
  autopilotSidebar: "AutopilotSidebarLink",
  priorityMatrixPage: "PriorityMatrixPage",
  priorityMatrixSidebar: "PriorityMatrixSidebarLink",
  dashboardWidget: "App1nDashboardWidget",
} as const;

export const DATA_KEYS = {
  features: "features",
  handoffs: "handoffs",
  brainDumpNotes: "brain-dump-notes",
  missionStatus: "mission-status",
} as const;

export const ACTION_KEYS = {
  saveBrainDump: "save-brain-dump",
} as const;
