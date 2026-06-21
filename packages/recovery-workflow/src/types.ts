export interface RecoveryWorkflowParams {
  companyId: string;
  actionId: string;
  sourceIssueId: string;
  mode: "shadow" | "active";
}

export interface Env {
  RECOVERY_WORKFLOW: Workflow;
  INTERNAL_API_BASE_URL: string;
  INTERNAL_API_SECRET: string;
}
