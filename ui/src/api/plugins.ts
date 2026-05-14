/**
 * @fileoverview Frontend API client for the Paperclip plugin system.
 *
 * All functions in `pluginsApi` map 1:1 to REST endpoints on
 * `server/src/routes/plugins.ts`. Call sites should consume these functions
 * through React Query hooks (`useQuery` / `useMutation`) and reference cache
 * keys from `queryKeys.plugins.*`.
 *
 * @see ui/src/lib/queryKeys.ts for cache key definitions.
 * @see server/src/routes/plugins.ts for endpoint implementation details.
 */

import type {
  PluginLauncherDeclaration,
  PluginLauncherRenderContextSnapshot,
  PluginUiSlotDeclaration,
  PluginLocalFolderDeclaration,
  PluginRecord,
  PluginConfig,
  PluginStatus,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Normalized UI contribution record returned by `GET /api/plugins/ui-contributions`.
 *
 * Only populated for plugins in `ready` state that declare at least one UI slot
 * or launcher. The `slots` array is sourced from `manifest.ui.slots`. The
 * `launchers` array aggregates both legacy `manifest.launchers` and
 * `manifest.ui.launchers`.
 */
export type PluginUiContribution = {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  updatedAt?: string;
  /**
   * Relative filename of the UI entry module within the plugin's UI directory.
   * The host constructs the full import URL as
   * `/_plugins/${pluginId}/ui/${uiEntryFile}`.
   */
  uiEntryFile: string;
  slots: PluginUiSlotDeclaration[];
  launchers: PluginLauncherDeclaration[];
};

/**
 * Health check result returned by `GET /api/plugins/:pluginId/health`.
 *
 * The `healthy` flag summarises whether all checks passed. Individual check
 * results are available in `checks` for detailed diagnostics display.
 */
export interface PluginHealthCheckResult {
  pluginId: string;
  /** The plugin's current lifecycle status at time of check. */
  status: string;
  /** True if all health checks passed. */
  healthy: boolean;
  /** Individual diagnostic check results. */
  checks: Array<{
    name: string;
    passed: boolean;
    /** Human-readable description of a failure, if any. */
    message?: string;
  }>;
  /** The most recent error message if the plugin is in `error` state. */
  lastError?: string;
}

/**
 * Worker diagnostics returned as part of the dashboard response.
 */
export interface PluginWorkerDiagnostics {
  status: string;
  pid: number | null;
  uptime: number | null;
  consecutiveCrashes: number;
  totalCrashes: number;
  pendingRequests: number;
  lastCrashAt: number | null;
  nextRestartAt: number | null;
}

/**
 * A recent job run entry returned in the dashboard response.
 */
export interface PluginDashboardJobRun {
  id: string;
  jobId: string;
  jobKey?: string;
  trigger: string;
  status: string;
  durationMs: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * A recent webhook delivery entry returned in the dashboard response.
 */
export interface PluginDashboardWebhookDelivery {
  id: string;
  webhookKey: string;
  status: string;
  durationMs: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * Aggregated health dashboard data returned by `GET /api/plugins/:pluginId/dashboard`.
 *
 * Contains worker diagnostics, recent job runs, recent webhook deliveries,
 * and the current health check result — all in a single response.
 */
export interface PluginDashboardData {
  pluginId: string;
  /** Worker process diagnostics, or null if no worker is registered. */
  worker: PluginWorkerDiagnostics | null;
  /** Recent job execution history (newest first, max 10). */
  recentJobRuns: PluginDashboardJobRun[];
  /** Recent inbound webhook deliveries (newest first, max 10). */
  recentWebhookDeliveries: PluginDashboardWebhookDelivery[];
  /** Current health check results. */
  health: PluginHealthCheckResult;
  /** ISO 8601 timestamp when the dashboard data was generated. */
  checkedAt: string;
}

export interface AvailablePluginExample {
  packageName: string;
  pluginKey: string;
  displayName: string;
  description: string;
  localPath: string;
  tag: "example";
}

export interface PluginLocalFolderProblem {
  code:
    | "not_configured"
    | "not_absolute"
    | "missing"
    | "not_directory"
    | "not_readable"
    | "not_writable"
    | "missing_directory"
    | "missing_file"
    | "path_traversal"
    | "symlink_escape"
    | "atomic_write_failed";
  message: string;
  path?: string;
}

export interface PluginLocalFolderStatus {
  folderKey: string;
  configured: boolean;
  path: string | null;
  realPath: string | null;
  access: "read" | "readWrite";
  readable: boolean;
  writable: boolean;
  requiredDirectories: string[];
  requiredFiles: string[];
  missingDirectories: string[];
  missingFiles: string[];
  healthy: boolean;
  problems: PluginLocalFolderProblem[];
  checkedAt: string;
}

export interface PluginLocalFoldersResponse {
  pluginId: string;
  companyId: string;
  declarations: PluginLocalFolderDeclaration[];
  folders: PluginLocalFolderStatus[];
}

export interface PluginLocalFolderSaveInput {
  path: string;
  access?: "read" | "readWrite";
  requiredDirectories?: string[];
  requiredFiles?: string[];
}

/**
 * Plugin management API client.
 *
 * All methods are thin wrappers around the `api` base client. They return
 * promises that resolve to typed JSON responses or throw on HTTP errors.
 *
 * @example
 * ```tsx
 * // In a component:
 * const { data: plugins } = useQuery({
 *   queryKey: queryKeys.plugins.all,
 *   queryFn: () => pluginsApi.list(),
 * });
 * ```
 */
export const pluginsApi = {
  /**
   * List all installed plugins, optionally filtered by lifecycle status.
   *
   * @param status - Optional filter; must be a valid `PluginStatus` value.
   *   Invalid values are rejected by the server with HTTP 400.
   */
  list: (status?: PluginStatus) =>
    api.get<PluginRecord[]>(`/plugins${status ? `?status=${status}` : ""}`),

  /**
   * List bundled example plugins available from the current repo checkout.
   */
  listExamples: () =>
    api.get<AvailablePluginExample[]>("/plugins/examples"),

  /**
   * Fetch a single plugin record by its UUID or plugin key.
   *
   * @param pluginId - The plugin's UUID (from `PluginRecord.id`) or plugin key.
   */
  get: (pluginId: string) =>
    api.get<PluginRecord>(`/plugins/${pluginId}`),

  /**
   * Install a plugin from npm or a local path.
   *
   * On success, the plugin is registered in the database and transitioned to
   * `ready` state. The response is the newly created `PluginRecord`.
   *
   * @param params.packageName - npm package name (e.g. `@paperclip/plugin-linear`)
   *   or a filesystem path when `isLocalPath` is `true`.
   * @param params.version - Target npm version tag/range (optional; defaults to latest).
   * @param params.isLocalPath - Set to `true` when `packageName` is a local path.
   */
  install: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
    api.post<PluginRecord>("/plugins/install", params),

  /**
   * Uninstall a plugin.
   *
   * @param pluginId - UUID of the plugin to remove.
   * @param purge - If `true`, permanently delete all plugin data (hard delete).
   *   Otherwise the plugin is soft-deleted with a 30-day data retention window.
   */
  uninstall: (pluginId: string, purge?: boolean) =>
    api.delete<{ ok: boolean }>(`/plugins/${pluginId}${purge ? "?purge=true" : ""}`),

  /**
   * Transition a plugin from `error` state back to `ready`.
   * No-ops if the plugin is already enabled.
   *
   * @param pluginId - UUID of the plugin to enable.
   */
  enable: (pluginId: string) =>
    api.post<{ ok: boolean }>(`/plugins/${pluginId}/enable`, {}),

  /**
   * Disable a plugin (transition to `error` state with an operator sentinel).
   * The plugin's worker is stopped; it will not process events until re-enabled.
   *
   * @param pluginId - UUID of the plugin to disable.
   * @param reason - Optional human-readable reason stored in `lastError`.
   */
  disable: (pluginId: string, reason?: string) =>
    api.post<{ ok: boolean }>(`/plugins/${pluginId}/disable`, reason ? { reason } : {}),

  /**
   * Run health diagnostics for a plugin.
   *
   * Only meaningful for plugins in `ready` state. Returns the result of all
   * registered health checks. Called on a 30-second polling interval by
   * {@link PluginSettings}.
   *
   * @param pluginId - UUID of the plugin to health-check.
   */
  health: (pluginId: string) =>
    api.get<PluginHealthCheckResult>(`/plugins/${pluginId}/health`),

  /**
   * Fetch aggregated health dashboard data for a plugin.
   *
   * Returns worker diagnostics, recent job runs, recent webhook deliveries,
   * and the current health check result in a single request. Used by the
   * {@link PluginSettings} page to render the runtime dashboard section.
   *
   * @param pluginId - UUID of the plugin.
   */
  dashboard: (pluginId: string) =>
    api.get<PluginDashboardData>(`/plugins/${pluginId}/dashboard`),

  /**
   * Fetch recent log entries for a plugin.
   *
   * @param pluginId - UUID of the plugin.
   * @param options - Optional filters: limit, level, since.
   */
  logs: (pluginId: string, options?: { limit?: number; level?: string; since?: string }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.level) params.set("level", options.level);
    if (options?.since) params.set("since", options.since);
    const qs = params.toString();
    return api.get<Array<{ id: string; pluginId: string; level: string; message: string; meta: Record<string, unknown> | null; createdAt: string }>>(
      `/plugins/${pluginId}/logs${qs ? `?${qs}` : ""}`,
    );
  },

  /**
   * Upgrade a plugin to a newer version.
   *
   * If the new version declares additional capabilities, the plugin is
   * transitioned to `upgrade_pending` state awaiting operator approval.
   *
   * @param pluginId - UUID of the plugin to upgrade.
   * @param version - Target version (optional; defaults to latest published).
   */
  upgrade: (pluginId: string, version?: string) =>
    api.post<{ ok: boolean }>(`/plugins/${pluginId}/upgrade`, version ? { version } : {}),

  /**
   * Returns normalized UI contribution declarations for ready plugins.
   * Used by the slot host runtime and launcher discovery surfaces.
   *
   * Response shape:
   * - `slots`: concrete React mount declarations from `manifest.ui.slots`
   * - `launchers`: host-owned entry points from `manifest.ui.launchers` plus
   *   the legacy top-level `manifest.launchers`
   *
   * @example
   * ```ts
   * const rows = await pluginsApi.listUiContributions();
   * const toolbarLaunchers = rows.flatMap((row) =>
   *   row.launchers.filter((launcher) => launcher.placementZone === "toolbarButton"),
   * );
   * ```
   */
  listUiContributions: () =>
    api.get<PluginUiContribution[]>("/plugins/ui-contributions"),

  // ===========================================================================
  // Plugin configuration endpoints
  // ===========================================================================

  /**
   * Fetch the current configuration for a plugin.
   *
   * Returns the `PluginConfig` record if one exists, or `null` if the plugin
   * has not yet been configured.
   *
   * @param pluginId - UUID of the plugin.
   */
  getConfig: (pluginId: string) =>
    api.get<PluginConfig | null>(`/plugins/${pluginId}/config`),

  /**
   * Save (create or update) the configuration for a plugin.
   *
   * The server validates `configJson` against the plugin's `instanceConfigSchema`
   * and returns the persisted `PluginConfig` record on success.
   *
   * @param pluginId - UUID of the plugin.
   * @param configJson - Configuration values matching the plugin's `instanceConfigSchema`.
   */
  saveConfig: (pluginId: string, configJson: Record<string, unknown>) =>
    api.post<PluginConfig>(`/plugins/${pluginId}/config`, { configJson }),

  /**
   * Call the plugin's `validateConfig` RPC method to test the configuration
   * without persisting it.
   *
   * Returns `{ valid: true }` on success, or `{ valid: false, message: string }`
   * when the plugin reports a validation failure.
   *
   * Only available when the plugin declares a `validateConfig` RPC handler.
   *
   * @param pluginId - UUID of the plugin.
   * @param configJson - Configuration values to validate.
   */
  testConfig: (pluginId: string, configJson: Record<string, unknown>) =>
    api.post<{ valid: boolean; message?: string }>(`/plugins/${pluginId}/config/test`, { configJson }),

  /**
   * List manifest-declared and stored company-scoped local folders for a plugin.
   */
  listLocalFolders: (pluginId: string, companyId: string) =>
    api.get<PluginLocalFoldersResponse>(`/plugins/${pluginId}/companies/${companyId}/local-folders`),

  /**
   * Inspect a configured local folder without changing persisted settings.
   */
  localFolderStatus: (pluginId: string, companyId: string, folderKey: string) =>
    api.get<PluginLocalFolderStatus>(
      `/plugins/${pluginId}/companies/${companyId}/local-folders/${encodeURIComponent(folderKey)}/status`,
    ),

  /**
   * Validate a candidate local folder path without saving it.
   */
  validateLocalFolder: (
    pluginId: string,
    companyId: string,
    folderKey: string,
    input: PluginLocalFolderSaveInput,
  ) =>
    api.post<PluginLocalFolderStatus>(
      `/plugins/${pluginId}/companies/${companyId}/local-folders/${encodeURIComponent(folderKey)}/validate`,
      input,
    ),

  /**
   * Persist a company-scoped local folder path and return its inspected status.
   */
  configureLocalFolder: (
    pluginId: string,
    companyId: string,
    folderKey: string,
    input: PluginLocalFolderSaveInput,
  ) =>
    api.put<PluginLocalFolderStatus>(
      `/plugins/${pluginId}/companies/${companyId}/local-folders/${encodeURIComponent(folderKey)}`,
      input,
    ),

  // ===========================================================================
  // Bridge proxy endpoints — used by the plugin UI bridge runtime
  // ===========================================================================

  /**
   * Proxy a `getData` call from a plugin UI component to its worker backend.
   *
   * This is the HTTP transport for `usePluginData(key, params)`. The bridge
   * runtime calls this method and maps the response into `PluginDataResult<T>`.
   *
   * On success, the response is `{ data: T }`.
   * On failure, the response body is a `PluginBridgeError`-shaped object
   * with `code`, `message`, and optional `details`.
   *
   * @param pluginId - UUID of the plugin whose worker should handle the request
   * @param key - Plugin-defined data key (e.g. `"sync-health"`)
   * @param params - Optional query parameters forwarded to the worker handler
   * @param companyId - Optional company scope used for board/company access checks.
   * @param renderEnvironment - Optional launcher/page snapshot forwarded for
   *   launcher-backed UI so workers can distinguish modal, drawer, popover, and
   *   page execution.
   *
   * Error responses:
   * - `401`/`403` when auth or company access checks fail
   * - `404` when the plugin or handler key does not exist
   * - `409` when the plugin is not in a callable runtime state
   * - `5xx` with a `PluginBridgeError`-shaped body when the worker throws
   *
   * @see PLUGIN_SPEC.md §13.8 — `getData`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  bridgeGetData: (
    pluginId: string,
    key: string,
    params?: Record<string, unknown>,
    companyId?: string | null,
    renderEnvironment?: PluginLauncherRenderContextSnapshot | null,
  ) =>
    api.post<{ data: unknown }>(`/plugins/${pluginId}/data/${encodeURIComponent(key)}`, {
      companyId: companyId ?? undefined,
      params,
      renderEnvironment: renderEnvironment ?? undefined,
    }),

  /**
   * Proxy a `performAction` call from a plugin UI component to its worker backend.
   *
   * This is the HTTP transport for `usePluginAction(key)`. The bridge runtime
   * calls this method when the action function is invoked.
   *
   * On success, the response is `{ data: T }`.
   * On failure, the response body is a `PluginBridgeError`-shaped object
   * with `code`, `message`, and optional `details`.
   *
   * @param pluginId - UUID of the plugin whose worker should handle the request
   * @param key - Plugin-defined action key (e.g. `"resync"`)
   * @param params - Optional parameters forwarded to the worker handler
   * @param companyId - Optional company scope used for board/company access checks.
   * @param renderEnvironment - Optional launcher/page snapshot forwarded for
   *   launcher-backed UI so workers can distinguish modal, drawer, popover, and
   *   page execution.
   *
   * Error responses:
   * - `401`/`403` when auth or company access checks fail
   * - `404` when the plugin or handler key does not exist
   * - `409` when the plugin is not in a callable runtime state
   * - `5xx` with a `PluginBridgeError`-shaped body when the worker throws
   *
   * @see PLUGIN_SPEC.md §13.9 — `performAction`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  bridgePerformAction: (
    pluginId: string,
    key: string,
    params?: Record<string, unknown>,
    companyId?: string | null,
    renderEnvironment?: PluginLauncherRenderContextSnapshot | null,
  ) =>
    api.post<{ data: unknown }>(`/plugins/${pluginId}/actions/${encodeURIComponent(key)}`, {
      companyId: companyId ?? undefined,
      params,
      renderEnvironment: renderEnvironment ?? undefined,
    }),
};
