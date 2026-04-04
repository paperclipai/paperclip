export const queryKeys = {
  companies: {
    all: ["companies"] as const,
    detail: (id: string) => ["companies", id] as const,
    stats: ["companies", "stats"] as const,
  },
  companySkills: {
    list: (companyId: string) => ["company-skills", companyId] as const,
    detail: (companyId: string, skillId: string) => ["company-skills", companyId, skillId] as const,
    updateStatus: (companyId: string, skillId: string) =>
      ["company-skills", companyId, skillId, "update-status"] as const,
    file: (companyId: string, skillId: string, relativePath: string) =>
      ["company-skills", companyId, skillId, "file", relativePath] as const,
  },
  agents: {
    list: (companyId: string) => ["agents", companyId] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    runtimeState: (id: string) => ["agents", "runtime-state", id] as const,
    taskSessions: (id: string) => ["agents", "task-sessions", id] as const,
    skills: (id: string) => ["agents", "skills", id] as const,
    instructionsBundle: (id: string) => ["agents", "instructions-bundle", id] as const,
    instructionsFile: (id: string, relativePath: string) =>
      ["agents", "instructions-bundle", id, "file", relativePath] as const,
    keys: (agentId: string) => ["agents", "keys", agentId] as const,
    configRevisions: (agentId: string) => ["agents", "config-revisions", agentId] as const,
    adapterModels: (companyId: string, adapterType: string) =>
      ["agents", companyId, "adapter-models", adapterType] as const,
    detectModel: (companyId: string, adapterType: string) =>
      ["agents", companyId, "detect-model", adapterType] as const,
  },
  issues: {
    list: (companyId: string) => ["issues", companyId] as const,
    search: (companyId: string, q: string, projectId?: string) =>
      ["issues", companyId, "search", q, projectId ?? "__all-projects__"] as const,
    listAssignedToMe: (companyId: string) => ["issues", companyId, "assigned-to-me"] as const,
    listMineByMe: (companyId: string) => ["issues", companyId, "mine-by-me"] as const,
    listTouchedByMe: (companyId: string) => ["issues", companyId, "touched-by-me"] as const,
    listUnreadTouchedByMe: (companyId: string) => ["issues", companyId, "unread-touched-by-me"] as const,
    labels: (companyId: string) => ["issues", companyId, "labels"] as const,
    listByProject: (companyId: string, projectId: string) =>
      ["issues", companyId, "project", projectId] as const,
    listByExecutionWorkspace: (companyId: string, executionWorkspaceId: string) =>
      ["issues", companyId, "execution-workspace", executionWorkspaceId] as const,
    detail: (id: string) => ["issues", "detail", id] as const,
    comments: (issueId: string) => ["issues", "comments", issueId] as const,
    feedbackVotes: (issueId: string) => ["issues", "feedback-votes", issueId] as const,
    attachments: (issueId: string) => ["issues", "attachments", issueId] as const,
    documents: (issueId: string) => ["issues", "documents", issueId] as const,
    documentRevisions: (issueId: string, key: string) => ["issues", "document-revisions", issueId, key] as const,
    activity: (issueId: string) => ["issues", "activity", issueId] as const,
    runs: (issueId: string) => ["issues", "runs", issueId] as const,
    approvals: (issueId: string) => ["issues", "approvals", issueId] as const,
    liveRuns: (issueId: string) => ["issues", "live-runs", issueId] as const,
    activeRun: (issueId: string) => ["issues", "active-run", issueId] as const,
    workProducts: (issueId: string) => ["issues", "work-products", issueId] as const,
  },
  routines: {
    list: (companyId: string) => ["routines", companyId] as const,
    detail: (id: string) => ["routines", "detail", id] as const,
    runs: (id: string) => ["routines", "runs", id] as const,
    activity: (companyId: string, id: string) => ["routines", "activity", companyId, id] as const,
  },
  executionWorkspaces: {
    list: (companyId: string, filters?: Record<string, string | boolean | undefined>) =>
      ["execution-workspaces", companyId, filters ?? {}] as const,
    detail: (id: string) => ["execution-workspaces", "detail", id] as const,
    closeReadiness: (id: string) => ["execution-workspaces", "close-readiness", id] as const,
    workspaceOperations: (id: string) => ["execution-workspaces", "workspace-operations", id] as const,
  },
  projects: {
    list: (companyId: string) => ["projects", companyId] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
  },
  goals: {
    list: (companyId: string) => ["goals", companyId] as const,
    detail: (id: string) => ["goals", "detail", id] as const,
  },
  budgets: {
    overview: (companyId: string) => ["budgets", "overview", companyId] as const,
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
  instance: {
    generalSettings: ["instance", "general-settings"] as const,
    schedulerHeartbeats: ["instance", "scheduler-heartbeats"] as const,
    experimentalSettings: ["instance", "experimental-settings"] as const,
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
  usageByProvider: (companyId: string, from?: string, to?: string) =>
    ["usage-by-provider", companyId, from, to] as const,
  usageByBiller: (companyId: string, from?: string, to?: string) =>
    ["usage-by-biller", companyId, from, to] as const,
  financeSummary: (companyId: string, from?: string, to?: string) =>
    ["finance-summary", companyId, from, to] as const,
  financeByBiller: (companyId: string, from?: string, to?: string) =>
    ["finance-by-biller", companyId, from, to] as const,
  financeByKind: (companyId: string, from?: string, to?: string) =>
    ["finance-by-kind", companyId, from, to] as const,
  financeEvents: (companyId: string, from?: string, to?: string, limit: number = 100) =>
    ["finance-events", companyId, from, to, limit] as const,
  usageWindowSpend: (companyId: string) =>
    ["usage-window-spend", companyId] as const,
  usageQuotaWindows: (companyId: string) =>
    ["usage-quota-windows", companyId] as const,
  heartbeats: (companyId: string, agentId?: string) =>
    ["heartbeats", companyId, agentId] as const,
  runDetail: (runId: string) => ["heartbeat-run", runId] as const,
  runWorkspaceOperations: (runId: string) => ["heartbeat-run", runId, "workspace-operations"] as const,
  liveRuns: (companyId: string) => ["live-runs", companyId] as const,
  runIssues: (runId: string) => ["run-issues", runId] as const,
  org: (companyId: string) => ["org", companyId] as const,
  skills: {
    available: ["skills", "available"] as const,
  },
  plugins: {
    all: ["plugins"] as const,
    examples: ["plugins", "examples"] as const,
    detail: (pluginId: string) => ["plugins", pluginId] as const,
    health: (pluginId: string) => ["plugins", pluginId, "health"] as const,
    uiContributions: ["plugins", "ui-contributions"] as const,
    config: (pluginId: string) => ["plugins", pluginId, "config"] as const,
    dashboard: (pluginId: string) => ["plugins", pluginId, "dashboard"] as const,
    logs: (pluginId: string) => ["plugins", pluginId, "logs"] as const,
  },
};
