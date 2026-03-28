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
    reviewBundle: (issueId: string) => ["issues", "review-bundle", issueId] as const,
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
    members: (companyId: string) => ["access", "members", companyId] as const,
    memberPermissions: (companyId: string, memberId: string) =>
      ["access", "member-permissions", companyId, memberId] as const,
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
  costsTrend: (companyId: string, from?: string, to?: string) =>
    ["costs-trend", companyId, from, to] as const,
  costsForecast: (companyId: string) =>
    ["costs-forecast", companyId] as const,
  costsEfficiency: (companyId: string, from?: string, to?: string) =>
    ["costs-efficiency", companyId, from, to] as const,
  heartbeats: (companyId: string, agentId?: string) =>
    ["heartbeats", companyId, agentId] as const,
  runDetail: (runId: string) => ["heartbeat-run", runId] as const,
  liveRuns: (companyId: string) => ["live-runs", companyId] as const,
  failedRuns: (companyId: string) => ["failed-runs", companyId] as const,
  runIssues: (runId: string) => ["run-issues", runId] as const,
  chatCompanySessions: (companyId: string) =>
    ["chat", "company-sessions", companyId] as const,
  chatSessions: (agentId: string, includeArchived: boolean = false) =>
    ["chat", "sessions", agentId, includeArchived ? "with-archived" : "active-only"] as const,
  chatMessages: (agentId: string, sessionId: string) => ["chat", "messages", agentId, sessionId] as const,
  chatUnreadSessions: (agentId: string) => ["chat", "unread-sessions", agentId] as const,
  skills: {
    list: (companyId: string) => ["skills", companyId] as const,
    detail: (id: string) => ["skills", "detail", id] as const,
    forAgent: (agentId: string) => ["skills", "agent", agentId] as const,
    assignmentsForAgent: (agentId: string) => ["skills", "assignments", agentId] as const,
  },
  webhooks: {
    endpoints: (companyId: string) => ["webhooks", companyId, "endpoints"] as const,
    rules: (endpointId: string) => ["webhooks", endpointId, "rules"] as const,
    companyRules: (companyId: string) => ["webhooks", companyId, "company-rules"] as const,
    endpointEvents: (endpointId: string) => ["webhooks", endpointId, "events"] as const,
    companyEvents: (companyId: string, endpointId?: string) =>
      ["webhooks", companyId, "events", endpointId ?? "__all__"] as const,
  },
  taskCrons: {
    company: (companyId: string) => ["task-crons", companyId, "company"] as const,
    byAgent: (agentId: string) => ["task-crons", "agent", agentId] as const,
    byIssue: (issueId: string) => ["task-crons", "issue", issueId] as const,
  },
  workspace: {
    files: (agentId: string, path: string) => ["workspace", "files", agentId, path] as const,
    content: (agentId: string, path: string) => ["workspace", "content", agentId, path] as const,
  },
  mcpServers: (agentId: string) => ["mcp-servers", agentId] as const,
  telegram: (agentId: string) => ["telegram", agentId] as const,
  mcpInstructions: (agentId: string, serverName: string) =>
    ["mcp-instructions", agentId, serverName] as const,
  inboxDismissals: (companyId: string) => ["inbox-dismissals", companyId] as const,
  inboxFeed: (companyId: string) => ["inbox-feed", companyId] as const,
  org: (companyId: string) => ["org", companyId] as const,
};
