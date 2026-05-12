export type PipelineRunStatus = "running" | "paused" | "completed" | "failed" | "escalated" | "cancelled";

export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type StageType = "stage" | "fan_out" | "fan_in" | "sub-pipeline";

export type FanInStrategy = "all_complete" | "first_complete" | "n_of_m";

interface BaseStage {
  id: string;
}

export interface Stage extends BaseStage {
  type: "stage";
  agent_role: string;
  instructions?: string;
  output_schema?: string;
}

export interface FanOutStage extends BaseStage {
  type: "fan_out";
  agent_role?: string;
  instructions?: string;
  per_task?: boolean;
  ordering?: string;
}

export interface FanInStage extends BaseStage {
  type: "fan_in";
  fan_in_strategy: FanInStrategy;
}

export interface SubPipelineStage extends BaseStage {
  type: "sub-pipeline";
  pipeline: string;
  per_task?: boolean;
  ordering?: string;
}

export type StageDefinition = Stage | FanOutStage | FanInStage | SubPipelineStage;

export interface PipelineTrigger {
  label: string;
}

export interface EdgeDefinition {
  id: string;
  from: string;
  to: string;
  type?: "default" | "error";
  sourceHandle?: string;  // decision enum value
  label?: string;
}

export interface PipelineDefinition {
  name: string;
  description: string;
  trigger: PipelineTrigger;
  stages: StageDefinition[];
  edges: EdgeDefinition[];
  positions: Record<string, { x: number; y: number }>;
}

export interface PipelineRun {
  id: string;
  companyId: string;
  parentIssueId: string;
  pipelineName: string;
  pipelineVersion: number;
  pipelineYaml: string;
  status: PipelineRunStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PipelineStage {
  id: string;
  pipelineRunId: string;
  stageId: string;
  subIssueId: string | null;
  status: StageStatus;
  retryCount: number;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface SubPipelineRun {
  id: string;
  parentPipelineRunId: string;
  parentStageId: string;
  childPipelineRunId: string;
  taskIndex: number;
  orderingPosition: number;
}

export interface RoleMapping {
  [role: string]: string;
}

export interface PipelineEngineConfig {
  role_mapping: RoleMapping;
  trigger_labels: Record<string, string>;
}

export interface StageOutput {
  status?: string;
  decision?: string;
  [key: string]: unknown;
}

export interface ExpressionContext {
  stages: Record<string, { output: StageOutput | StageOutput[] | null; status: StageStatus; retry_count: number }>;
  pipeline: { name: string; version: number; parent_issue_id: string };
  env: { company_id: string };
  output?: StageOutput | StageOutput[] | null;
}

export interface DispatchRequest {
  pipelineRunId: string;
  stage: StageDefinition;
  companyId: string;
  parentIssueId: string;
  context?: string;
}

export type ParsedOutput =
  | { valid: true; data: Record<string, unknown> }
  | { valid: false; data: null; error: string };

export type FailureAction =
  | { action: "goto"; targetStageId: string; body?: string }
  | { action: "escalate" };

export interface CreateIssueInput {
  companyId: string;
  parentId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeAgentId?: string;
  billingCode?: string;
  originKind?: string;
  originId?: string;
  inheritExecutionWorkspaceFromIssueId?: string;
}

export interface WakeupOptions {
  reason: string;
  contextSource: string;
  idempotencyKey: string;
}
