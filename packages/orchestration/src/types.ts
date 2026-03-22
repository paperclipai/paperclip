// Core types for the Paperclip agent orchestration layer

export type IssuePriority = "critical" | "high" | "medium" | "low";
export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export interface PaperclipClientConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string;
  /** Run ID to include in mutating requests for audit trail */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Agent primitives
// ---------------------------------------------------------------------------

export interface AgentSummary {
  id: string;
  name: string;
  nameKey: string;
  role: string;
  status: string;
  adapterType: string;
  managerId: string | null;
}

export interface SpawnAgentInput {
  name: string;
  role: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
  /** Chain-of-command: who this agent reports to */
  managerId?: string;
  /** Optional skills to assign on creation */
  desiredSkills?: string[];
}

export interface SpawnAgentResult {
  agentId: string;
  approvalId: string | null;
  requiresApproval: boolean;
}

// ---------------------------------------------------------------------------
// Task / issue primitives
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  title: string;
  description?: string;
  assigneeAgentId?: string;
  parentId?: string;
  goalId?: string;
  priority?: IssuePriority;
  status?: IssueStatus;
  billingCode?: string;
}

export interface TaskSummary {
  id: string;
  identifier: string;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  parentId: string | null;
  goalId: string | null;
}

export interface HandoffInput {
  issueId: string;
  toAgentId: string;
  comment?: string;
  newStatus?: IssueStatus;
}

// ---------------------------------------------------------------------------
// Messaging primitives
// ---------------------------------------------------------------------------

export interface PostMessageInput {
  issueId: string;
  body: string;
}

export interface CommentSummary {
  id: string;
  issueId: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Pipeline primitives
// ---------------------------------------------------------------------------

export type PipelineStepFn = (
  ctx: PipelineContext,
) => Promise<PipelineStepResult>;

export interface PipelineStep {
  name: string;
  assigneeAgentId: string;
  taskTitle: string;
  taskDescription?: string;
  priority?: IssuePriority;
}

export interface PipelineContext {
  companyId: string;
  goalId?: string;
  parentId?: string;
  previousTaskId?: string;
  previousTaskStatus?: IssueStatus;
  metadata: Record<string, unknown>;
}

export interface PipelineStepResult {
  taskId: string;
  status: IssueStatus;
  metadata?: Record<string, unknown>;
}

export interface PipelineRunResult {
  steps: Array<{
    stepName: string;
    taskId: string;
    status: IssueStatus;
  }>;
  succeeded: boolean;
}
