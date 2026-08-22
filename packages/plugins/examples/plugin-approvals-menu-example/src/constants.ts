/**
 * Stable plugin identifiers shared between the manifest and runtime code.
 */
export const PLUGIN_ID = "paperclip.approvals-menu-example";
export const PLUGIN_VERSION = "0.1.0";

export const SIDEBAR_SLOT_ID = "approvals-menu-link";
export const PAGE_SLOT_ID = "approvals-menu-page";

export const EXPORT_NAMES = {
  sidebar: "ApprovalsMenuLink",
  page: "ApprovalsMenuPage",
} as const;

/** Plugin-owned page route, mounted at `/:companyPrefix/approvals-menu`. */
export const PAGE_ROUTE = "approvals-menu";

export const DEFAULT_CONFIG = {
  /** Auto-refresh interval for the badge + list view (seconds). 0 disables polling. */
  refreshIntervalSeconds: 60,
  /** Whether to surface a numeric pending count badge on the sidebar link. */
  showBadge: true,
  /**
   * Max rows displayed in the pending list page. The host approvals API does
   * not accept a `limit` query parameter, so this cap is applied client-side
   * after the response is received.
   */
  listLimit: 50,
};

export type ApprovalsMenuPluginConfig = typeof DEFAULT_CONFIG;
