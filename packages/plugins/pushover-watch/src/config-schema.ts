export type CompanyConfig = {
  companyId: string;
  issuePrefix: string;
  topAgentIds: string[];
  secretaryAgentIds?: string[];
  enabled?: boolean;
};

export type PluginConfig = {
  pushoverUserKeyRef: string;
  pushoverAppTokenRef: string;
  boardUserId: string;
  clickbackBaseUrl: string;
  dryRun?: boolean;
  companies: CompanyConfig[];
};

export type CachedIssueState = {
  status:
    | "backlog"
    | "todo"
    | "in_progress"
    | "in_review"
    | "done"
    | "blocked"
    | "cancelled";
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: string;
};
