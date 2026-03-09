/**
 * Centralized React Query cache key registry.
 *
 * All query keys used throughout the frontend must be defined here. This
 * ensures consistent cache invalidation — when a mutation succeeds, it can
 * call `invalidateQueries({ queryKey: queryKeys.foo.all })` to bust all
 * related caches without needing to know the exact key shapes at the call site.
 *
 * **Key hierarchy convention**
 *
 * Keys are structured as arrays of segments so that React Query's prefix
 * invalidation works correctly:
 *
 * ```
 * queryKeys.plugins.all              → ["plugins"]
 * queryKeys.plugins.detail("p1")    → ["plugins", "p1"]
 * queryKeys.plugins.health("p1")    → ["plugins", "p1", "health"]
 * ```
 *
 * Invalidating `queryKeys.plugins.all` (the prefix `["plugins"]`) will
 * automatically invalidate every `detail`, `health`, and `uiContributions`
 * entry, because React Query matches by prefix.
 *
 * **Adding new keys**
 *
 * 1. Add the key factory here (not inline at the query call site).
 * 2. Use the entity name as the first segment and a descriptor as subsequent
 *    segments so the hierarchy is intuitive.
 * 3. Write tests in `queryKeys.test.ts` to assert the shape and prefix
 *    relationships.
 *
 * @see ui/src/lib/queryKeys.test.ts for coverage of all key shapes
 */
export const queryKeys = {
  companies: {
    all: ["companies"] as const,
    detail: (id: string) => ["companies", id] as const,
    stats: ["companies", "stats"] as const,
  },
  agents: {
    list: (companyId: string) => ["agents", companyId] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    runtimeState: (id: string) => ["agents", "runtime-state", id] as const,
    taskSessions: (id: string) => ["agents", "task-sessions", id] as const,
    keys: (agentId: string) => ["agents", "keys", agentId] as const,
    configRevisions: (agentId: string) => ["agents", "config-revisions", agentId] as const,
    adapterModels: (companyId: string, adapterType: string) =>
      ["agents", companyId, "adapter-models", adapterType] as const,
  },
  issues: {
    list: (companyId: string) => ["issues", companyId] as const,
    search: (companyId: string, q: string, projectId?: string) =>
      ["issues", companyId, "search", q, projectId ?? "__all-projects__"] as const,
    listAssignedToMe: (companyId: string) => ["issues", companyId, "assigned-to-me"] as const,
    listTouchedByMe: (companyId: string) => ["issues", companyId, "touched-by-me"] as const,
    listUnreadTouchedByMe: (companyId: string) => ["issues", companyId, "unread-touched-by-me"] as const,
    labels: (companyId: string) => ["issues", companyId, "labels"] as const,
    listByProject: (companyId: string, projectId: string) =>
      ["issues", companyId, "project", projectId] as const,
    detail: (id: string) => ["issues", "detail", id] as const,
    comments: (issueId: string) => ["issues", "comments", issueId] as const,
    attachments: (issueId: string) => ["issues", "attachments", issueId] as const,
    activity: (issueId: string) => ["issues", "activity", issueId] as const,
    runs: (issueId: string) => ["issues", "runs", issueId] as const,
    approvals: (issueId: string) => ["issues", "approvals", issueId] as const,
    liveRuns: (issueId: string) => ["issues", "live-runs", issueId] as const,
    activeRun: (issueId: string) => ["issues", "active-run", issueId] as const,
  },
  projects: {
    list: (companyId: string) => ["projects", companyId] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
  },
  goals: {
    list: (companyId: string) => ["goals", companyId] as const,
    detail: (id: string) => ["goals", "detail", id] as const,
  },
  approvals: {
    list: (companyId: string, status?: string) =>
      ["approvals", companyId, status] as const,
    detail: (approvalId: string) => ["approvals", "detail", approvalId] as const,
    comments: (approvalId: string) => ["approvals", "comments", approvalId] as const,
    issues: (approvalId: string) => ["approvals", "issues", approvalId] as const,
  },
  access: {
    joinRequests: (companyId: string, status: string = "pending_approval") =>
      ["access", "join-requests", companyId, status] as const,
    invite: (token: string) => ["access", "invite", token] as const,
  },
  auth: {
    session: ["auth", "session"] as const,
  },
  health: ["health"] as const,
  secrets: {
    list: (companyId: string) => ["secrets", companyId] as const,
    providers: (companyId: string) => ["secret-providers", companyId] as const,
  },
  dashboard: (companyId: string) => ["dashboard", companyId] as const,
  sidebarBadges: (companyId: string) => ["sidebar-badges", companyId] as const,
  activity: (companyId: string) => ["activity", companyId] as const,
  costs: (companyId: string, from?: string, to?: string) =>
    ["costs", companyId, from, to] as const,
  heartbeats: (companyId: string, agentId?: string) =>
    ["heartbeats", companyId, agentId] as const,
  liveRuns: (companyId: string) => ["live-runs", companyId] as const,
  runIssues: (runId: string) => ["run-issues", runId] as const,
  org: (companyId: string) => ["org", companyId] as const,
  plugins: {
    /**
     * Root key for all plugin queries. Invalidating this key will refresh
     * every plugin-related query (list, detail, health, ui-contributions).
     *
     * @example
     * ```ts
     * // After install/uninstall, refresh the full plugin list:
     * queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
     * ```
     */
    all: ["plugins"] as const,

    /**
     * Cache key for a single plugin record (`GET /api/plugins/:pluginId`).
     *
     * @param pluginId - The UUID or plugin key to look up.
     */
    detail: (pluginId: string) => ["plugins", pluginId] as const,

    /**
     * Cache key for a plugin's health check (`GET /api/plugins/:pluginId/health`).
     * Automatically refetched every 30 seconds while the plugin is in `ready` state.
     *
     * @param pluginId - The UUID or plugin key to health-check.
     */
    health: (pluginId: string) => ["plugins", pluginId, "health"] as const,

    /**
     * Cache key for plugin UI slot contributions (`GET /api/plugins/ui-contributions`).
     * Returns contributions from all `ready`-state plugins with declared UI slots.
     * Used by the frontend slot host to render plugin UI extensions.
     */
    uiContributions: (companyId?: string | null) =>
      ["plugins", "ui-contributions", companyId ?? "global"] as const,

    /**
     * Cache key for a plugin's configuration (`GET /api/plugins/:pluginId/config`).
     * Used by the auto-generated settings form on the plugin detail page.
     *
     * @param pluginId - The UUID of the plugin whose config to fetch.
     */
    config: (pluginId: string) => ["plugins", pluginId, "config"] as const,

    /**
     * Cache key for a plugin's aggregated dashboard data (`GET /api/plugins/:pluginId/dashboard`).
     * Contains worker status, recent jobs, recent webhooks, and health checks.
     * Polled every 30 seconds while the plugin settings page is open.
     *
     * @param pluginId - The UUID of the plugin.
     */
    dashboard: (pluginId: string) => ["plugins", pluginId, "dashboard"] as const,

    /**
     * Root key for all company-scoped plugin availability queries for one company.
     *
     * @param companyId - UUID of the company.
     */
    company: (companyId: string) => ["plugins", "company", companyId] as const,

    /**
     * Cache key for company-scoped plugin availability list
     * (`GET /api/companies/:companyId/plugins`).
     *
     * @param companyId - UUID of the company.
     * @param available - Optional availability filter.
     */
    companyList: (companyId: string, available?: boolean) =>
      [...queryKeys.plugins.company(companyId), "list", available ?? "all"] as const,

    /**
     * Cache key for a single company-scoped plugin availability record
     * (`GET /api/companies/:companyId/plugins/:pluginId`).
     *
     * @param companyId - UUID of the company.
     * @param pluginId - Plugin UUID or plugin key.
     */
    companyDetail: (companyId: string, pluginId: string) =>
      [...queryKeys.plugins.company(companyId), pluginId] as const,
  },
};
