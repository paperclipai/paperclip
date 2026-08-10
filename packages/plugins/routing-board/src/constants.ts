export const PLUGIN_ID = "nideas.routing-board";
export const PLUGIN_VERSION = "0.1.0";

// Route under the company prefix: /:companyPrefix/routing
export const PAGE_ROUTE = "routing";

export const SLOT_IDS = {
  page: "routing-board-page",
  sidebar: "routing-board-sidebar-link",
} as const;

export const EXPORT_NAMES = {
  page: "RoutingPage",
  sidebar: "RoutingSidebarLink",
} as const;

export const TOOL_NAMES = {
  listRoutings: "routing-list",
  getRouting: "routing-get",
  setDefaultRouting: "routing-set-default",
  createRouting: "routing-create",
  deleteRouting: "routing-delete",
  invokeHeartbeatWithRouting: "routing-heartbeat",
} as const;
