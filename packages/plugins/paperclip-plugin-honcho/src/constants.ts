import type { PluginLauncherRegistration } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip-plugin-honcho";
export const PLUGIN_VERSION = "0.1.0";
export const STATE_NAMESPACE = "honcho";
export const DEFAULT_WORKSPACE_PREFIX = "paperclip";
export const HONCHO_V2_PATH = "/v2";
export const HONCHO_V3_PATH = "/v3";
export const HONCHO_CONNECTION_PROBE_PATH = `${HONCHO_V3_PATH}/workspaces`;
export const DEFAULT_CONTEXT_SUMMARY_LIMIT = 3;
export const DEFAULT_SEARCH_LIMIT = 5;
export const DEFAULT_DOCUMENT_SECTION_SIZE = 1800;
export const DEFAULT_DOCUMENT_SECTION_OVERLAP = 200;
export const DEFAULT_BACKFILL_BATCH_SIZE = 100;

export const SLOT_IDS = {
  settingsPage: "honcho-settings-page",
  dashboardWidget: "honcho-dashboard-widget",
  issueTab: "honcho-issue-memory-tab",
} as const;

export const EXPORT_NAMES = {
  settingsPage: "HonchoSettingsPage",
  dashboardWidget: "HonchoDashboardWidget",
  issueTab: "HonchoIssueMemoryTab",
} as const;

export const DATA_KEYS = {
  setupStatus: "setup-status",
  issueStatus: "issue-memory-status",
} as const;

export const ACTION_KEYS = {
  testConnection: "test-connection",
  resyncIssue: "resync-issue",
  backfillCompany: "backfill-company",
} as const;

export const TOOL_NAMES = {
  getIssueContext: "honcho_get_issue_context",
  searchMemory: "honcho_search_memory",
  askPeer: "honcho_ask_peer",
} as const;

export const RUNTIME_LAUNCHERS: PluginLauncherRegistration[] = [];

export const DEFAULT_CONFIG = {
  honchoApiBaseUrl: "",
  honchoApiKeySecretRef: "",
  workspacePrefix: DEFAULT_WORKSPACE_PREFIX,
  syncIssueComments: true,
  syncIssueDocuments: false,
  enablePeerChat: false,
} as const;

export const ISSUE_STATUS_STATE_KEY = "issue-sync-status";
export const COMPANY_STATUS_STATE_KEY = "company-sync-status";
