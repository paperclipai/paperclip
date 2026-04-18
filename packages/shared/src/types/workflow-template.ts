import type { IssueExecutionPolicy } from "./issue.js";

export interface WorkflowTemplateNode {
  tempId: string;
  title: string;
  description?: string | null;
  blockedByTempIds: string[];
  parentTempId?: string | null;
  executionPolicy?: IssueExecutionPolicy | null;
  defaultAssigneeAgentId?: string | null;
  defaultPriority?: "critical" | "high" | "medium" | "low" | null;
  defaultProjectId?: string | null;
}

export interface WorkflowTemplate {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  nodes: WorkflowTemplateNode[];
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowTemplateListItem extends WorkflowTemplate {}

export interface WorkflowTemplateDetail extends WorkflowTemplate {}

export interface WorkflowInvokeResponse {
  rootIssueId: string;
  createdIssues: {
    tempId: string;
    issueId: string;
    title: string;
    status: "todo" | "blocked";
    assigneeAgentId: string | null;
  }[];
}
