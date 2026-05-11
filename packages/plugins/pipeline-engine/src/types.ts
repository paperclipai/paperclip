export type PipelineRunStatus = "running" | "paused" | "completed" | "failed" | "escalated";

export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type StageType = "worker" | "classifier" | "parallel_fan_out" | "gate" | "sub-pipeline";

export type FanInStrategy = "all_complete" | "first_complete";

export interface OnFailure {
  retry_with?: {
    goto: string;
    body: string;
    max_retries: number;
  };
}

export interface StageDefinition {
  id: string;
  type: StageType;
  agent_role?: string;
  depends_on?: string[];
  condition?: string;
  skip_if?: string;
  output_schema?: string;
  checkpoint?: boolean;
  fan_in?: FanInStrategy;
  timeout?: string;
  on_failure?: OnFailure;
  per_task?: boolean;
  ordering?: string;
  pipeline?: string;
  requires_approval?: boolean;
  stages?: StageDefinition[];
}

export interface PipelineTrigger {
  label: string;
}

export interface PipelineDefinition {
  name: string;
  description: string;
  trigger: PipelineTrigger;
  stages: StageDefinition[];
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
  pipelines_dir?: string;
}

export interface StageOutput {
  status?: string;
  decision?: string;
  [key: string]: unknown;
}

export interface ExpressionContext {
  stages: Record<string, { output: StageOutput | null; status: StageStatus; retry_count: number }>;
  pipeline: { name: string; version: number; parent_issue_id: string };
  env: { company_id: string };
}

export interface DispatchRequest {
  pipelineRunId: string;
  stage: StageDefinition;
  companyId: string;
  parentIssueId: string;
  context?: string;
}

export interface ParsedOutput {
  valid: boolean;
  data: Record<string, unknown> | null;
  error?: string;
}
