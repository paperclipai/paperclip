export const queryKeys = {
  companies: {
    all: ["companies"] as const,
    detail: (id: string) => ["companies", id] as const,
  },
  agents: {
    list: (companyId: string) => ["agents", companyId] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    runs: (agentId: string) => ["agents", "runs", agentId] as const,
    orgTree: (companyId: string) => ["agents", "org-tree", companyId] as const,
    models: (type: string) => ["agents", "models", type] as const,
  },
  issues: {
    list: (companyId: string) => ["issues", companyId] as const,
    detail: (id: string) => ["issues", "detail", id] as const,
    comments: (issueId: string) => ["issues", "comments", issueId] as const,
  },
  projects: {
    list: (companyId: string) => ["projects", companyId] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
    workspaces: (projectId: string) =>
      ["projects", "workspaces", projectId] as const,
  },
  goals: { list: (companyId: string) => ["goals", companyId] as const },
  approvals: {
    list: (companyId: string) => ["approvals", companyId] as const,
  },
  costs: {
    summary: (companyId: string) => ["costs", "summary", companyId] as const,
    byAgent: (companyId: string) => ["costs", "by-agent", companyId] as const,
    byModel: (companyId: string) => ["costs", "by-model", companyId] as const,
  },
  routines: {
    list: (companyId: string) => ["routines", companyId] as const,
    triggers: (routineId: string) =>
      ["routines", "triggers", routineId] as const,
    runs: (routineId: string) => ["routines", "runs", routineId] as const,
  },
  workflows: {
    list: (companyId: string) => ["workflows", companyId] as const,
  },
  activity: { list: (companyId: string, entityType?: string) => ["activity", companyId, entityType] as const },
  plugins: { all: ["plugins"] as const },
  localModels: { all: ["local-models"] as const },
};
