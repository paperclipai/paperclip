export interface WorkflowPipelinePhase {
  key: string;
  label: string;
  kind: "phase" | "agent" | "loop" | "tool" | "validator";
  filePath: string | null;
  functionName: string | null;
  ordinal: number;
  parentKey?: string | null;
  depth?: number;
  agentName?: string | null;
  description?: string | null;
}

export interface WorkflowPipelineDefinition {
  entrypoint: string;
  phases: WorkflowPipelinePhase[];
  generatedAt: string;
}

export interface Workflow {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  status: string;
  runnerType: "google_adk";
  runnerConfig: Record<string, unknown>;
  pipelineDefinition: WorkflowPipelineDefinition;
  pipelineSourceHash: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRunUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface WorkflowRun {
  id: string;
  companyId: string;
  workflowId: string;
  status: string;
  inputMarkdown: string;
  error: string | null;
  summary: string | null;
  provider: string | null;
  model: string | null;
  usage: WorkflowRunUsage | null;
  resultJson: Record<string, unknown> | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  consoleEntries: WorkflowRunConsoleChunk[];
  contextSnapshot: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRunConsoleChunk {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
}

export interface WorkflowPhase {
  id: string;
  companyId: string;
  workflowRunId: string;
  phaseKey: string;
  label: string;
  kind: "phase" | "agent" | "loop" | "tool" | "validator";
  ordinal: number;
  status: string;
  metadata: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowHandoff {
  id: string;
  companyId: string;
  workflowRunId: string;
  phaseKey: string;
  kind: "approval" | "response";
  status: string;
  promptMarkdown: string;
  responseMarkdown: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Present when a ClickUp bridge exists for this handoff. */
  bridgeStatus: "waiting_for_human" | "closed" | null;
}

export interface WorkflowDeliverableSummary {
  id: string;
  title: string;
  audience: string;
  contentType: string;
  contentPath: string | null;
  byteSize: number;
  originalFilename: string | null;
  createdAt: string;
}

export interface WorkflowRunDetail extends WorkflowRun {
  workflow: Pick<Workflow, "id" | "title" | "status" | "runnerType">;
  phases: WorkflowPhase[];
  handoffs: WorkflowHandoff[];
  deliverables: WorkflowDeliverableSummary[];
}

export interface WorkflowListItem extends Workflow {
  latestRun: WorkflowRun | null;
  currentPhase: Pick<WorkflowPhase, "phaseKey" | "label" | "status" | "ordinal"> | null;
  latestDeliverable: WorkflowDeliverableSummary | null;
}

export interface WorkflowDetail extends Workflow {
  latestRun: WorkflowRun | null;
  runs: WorkflowRun[];
  latestDeliverable: WorkflowDeliverableSummary | null;
}
