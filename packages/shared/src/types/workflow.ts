import type { WorkflowRunInvocationSummary } from "./workflow-invocation.js";

export type { WorkflowRunInvocationSummary } from "./workflow-invocation.js";

export interface WorkflowPipelinePhase {
  key: string;
  label: string;
  kind: "phase" | "agent" | "loop" | "tool" | "validator";
  filePath: string | null;
  functionName: string | null;
  ordinal: number;
  parentKey?: string | null;
  parentKeys?: string[];
  depth?: number;
  agentName?: string | null;
  description?: string | null;
  /** Literal Google ADK `instruction=` text when it can be read statically. */
  systemPrompt?: string | null;
  /** Skills referenced by the agent and resolved from the local workflow package. */
  configuredSkills?: Array<{ name: string; content: string }>;
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
  workflowKey?: string | null;
  capabilities?: string[];
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
  reviewStage: "content" | "final" | null;
  revision: number;
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
  invocation?: WorkflowRunInvocationSummary | null;
}

export interface WorkflowRunConsoleChunk {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
}

export type WorkflowTelemetryEventType =
  | "operation.started"
  | "operation.completed"
  | "operation.failed";

export type WorkflowTelemetryActorKind = "workflow" | "agent" | "model" | "tool" | "service" | "system";
export type WorkflowTelemetryOperationKind = "invocation" | "phase" | "agent" | "llm" | "tool" | "service";
export type WorkflowTelemetryStatus = "running" | "succeeded" | "failed";

export interface WorkflowTelemetryEventInput {
  schema: "bizbox.telemetry/v1";
  event: WorkflowTelemetryEventType;
  eventId: string;
  spanId: string;
  parentSpanId: string | null;
  sequence: number;
  timestamp: string;
  actor: {
    kind: WorkflowTelemetryActorKind;
    name: string | null;
  };
  operation: {
    kind: WorkflowTelemetryOperationKind;
    name: string;
  };
  status: WorkflowTelemetryStatus | null;
  input?: unknown;
  output?: unknown;
  attributes?: Record<string, unknown>;
  error?: string | null;
}

export interface WorkflowTelemetryEvent extends WorkflowTelemetryEventInput {
  id: string;
  companyId: string;
  workflowRunId: string;
  createdAt: string;
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
  reviewStage: "content" | "final" | null;
  revision: number;
  idempotencyKey: string | null;
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

export interface WorkflowSchedule {
  id: string;
  companyId: string;
  workflowId: string;
  title: string;
  status: string;
  cronExpression: string;
  timezone: string;
  templateMarkdown: string;
  lastFiredAt: Date | null;
  nextRunAt: Date | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRunDetail extends WorkflowRun {
  workflow: Pick<Workflow, "id" | "title" | "status" | "runnerType">;
  phases: WorkflowPhase[];
  handoffs: WorkflowHandoff[];
  deliverables: WorkflowDeliverableSummary[];
  telemetryEvents: WorkflowTelemetryEvent[];
}

export interface WorkflowRunEvent {
  id: string;
  idempotencyKey: string;
  createdAt: string;
  actor: "bizbox" | "human";
  phase: "grounding" | "planning" | "assets" | "review" | "revision";
  kind: "source_summary" | "screen_plan" | "asset_generated" | "review_requested" | "review_response" | "revision_applied";
  summary: string;
  details: Record<string, unknown>;
  revision: number;
}

export interface WorkflowRunAsset {
  id: string;
  deliverableId: string;
  screenNumber: number | null;
  postType?: string;
  templateId: string | null;
  viewableUrl: string;
  thumbnailUrl: string | null;
  revision: number;
  superseded: boolean;
}

export interface WorkflowExtensionWriteContext {
  idempotencyKey: string;
  generationId: string;
  revision: number;
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
  schedules?: WorkflowSchedule[];
}
