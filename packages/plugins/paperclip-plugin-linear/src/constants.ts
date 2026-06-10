export const PLUGIN_ID = "paperclip-plugin-linear";
export const PLUGIN_VERSION = "0.9.3";

/**
 * The originKind value the host stamps on issues created by this plugin.
 * Matches `defaultPluginOriginKind = `plugin:${pluginKey}`` in the host's
 * plugin-host-services.ts. Used by:
 *   - the webhook `Issue.create` handler when calling `ctx.issues.create`
 *   - the `issue.created` event-handler defense that suppresses feedback
 *     push-back-to-Linear for webhook-imported mirrors
 * The host's `normalizePluginOriginKind` allows extended forms like
 * `ORIGIN_KIND_SELF + ":<sub-origin>"`, so consumers should match on
 * `=== ORIGIN_KIND_SELF || startsWith(ORIGIN_KIND_SELF + ":")`.
 */
export const ORIGIN_KIND_SELF = `plugin:${PLUGIN_ID}` as const;

/** Linear project name used to bucket Paperclip goals as Linear issues. */
export const GOALS_LINEAR_PROJECT_NAME = "Company Goals";

export const TOOL_NAMES = {
  search: "search-linear-issues",
  resolveBinding: "resolve-linear-binding",
  setBinding: "set-linear-binding",
  link: "link-linear-issue",
  unlink: "unlink-linear-issue",
  create: "create-linear-issue",
  markDuplicate: "mark-duplicate",
} as const;

export const WEBHOOK_KEYS = {
  linear: "linear-events",
} as const;

export const JOB_KEYS = {
  periodicSync: "periodic-sync",
  initialImport: "initial-import",
} as const;

export const SLOT_IDS = {
  issueTab: "linear-issue-tab",
  settingsPage: "linear-settings",
} as const;

export const EXPORT_NAMES = {
  issueTab: "LinearIssueTab",
  settingsPage: "LinearSettingsPage",
} as const;

export const ACTION_KEYS = {
  oauthStart: "oauth-start",
  oauthCallback: "oauth-callback",
  oauthDisconnect: "oauth-disconnect",
  oauthStatus: "oauth-status",
  triggerImport: "trigger-import",
  triggerSync: "trigger-sync",
  listTeams: "list-teams",
  createTeam: "create-team",
  configure: "configure",
  linkIssue: "link-issue",
  unlinkIssue: "unlink-issue",
  importIssue: "import-issue",
  backfillBackLinks: "backfill-backlinks",
} as const;

export const DATA_KEYS = {
  issueLink: "issue-link",
  connectionStatus: "connection-status",
} as const;

export const STATE_KEYS = {
  linkPrefix: "link:",
  linearPrefix: "linear:",
  oauthToken: "oauth-token", // legacy — kept for migration
  secretTokenRef: "secret-token-ref",
  clientSecretRef: "client-secret-ref",
  oauthTeamId: "oauth-team-id",
  oauthTeamKey: "oauth-team-key",
  /** Workspace url-key (e.g. `blockcast`) used to build full Linear issue urls
   * when linkifying bare BLO-N refs at comment/description ingest. Cached at
   * OAuth connect time so we don't have to parse every link.linearUrl. */
  workspaceUrlKey: "workspace-url-key",
  companyId: "company-id",
  serverUrl: "server-url",
  connected: "connected",
  projectLinkPrefix: "project-link:",
  projectLinearPrefix: "project-linear:",
  periodicLinkSyncOffset: "periodic-sync-link-offset",
  goalLinkPrefix: "goal-link:",
  goalLinearPrefix: "goal-linear:",
  /** Cached Linear project id used as the bucket for synced goals (fallback when initiatives unsupported). */
  goalsLinearProjectId: "goals-linear-project-id",
  /** Boolean flag: true if workspace supports Linear Initiatives, false if not (plan limitation). */
  initiativesSupported: "initiatives-supported",
} as const;

export const LINEAR_OAUTH = {
  authorizeUrl: "https://linear.app/oauth/authorize",
  tokenUrl: "https://api.linear.app/oauth/token",
  revokeUrl: "https://api.linear.app/oauth/revoke",
  scopes: ["read", "write", "admin"],
} as const;

export const DEFAULT_CONFIG = {
  linearTokenRef: "",
  linearClientId: "",
  linearClientSecret: "",
  teamId: "",
  defaultProjectId: "",
  paperclipBaseUrl: "https://paperclip.blockcast.net",
  syncComments: true,
  syncDirection: "bidirectional" as const,
  disableLinearOriginatedCreates: true,
};
