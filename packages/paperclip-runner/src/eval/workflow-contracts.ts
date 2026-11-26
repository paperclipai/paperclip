import type { EvalObservation } from "./eval-scoring.js";

export const RUNNER_WORKFLOW_EVAL_CASE_SCHEMA = "paperclip.runner.workflow-eval-case.v1" as const;
export const RUNNER_WORKFLOW_OBSERVATION_SCHEMA = "paperclip.runner.workflow-observation.v1" as const;
export const RUNNER_WORKFLOW_SCORECARD_SCHEMA = "paperclip.runner.eval-scorecard.v2" as const;

export const RUNNER_WORKFLOW_IDS = [
  "final-response",
  "rich-activity",
  "verification-policy",
  "governed-interaction",
  "steering-causality",
  "planning-lifecycle",
  "review-lifecycle",
  "delegation-return",
  "completion-robustness",
  "restart-recovery",
  "cancellation-permissions",
  "trace-lineage",
] as const;

export type RunnerWorkflowId = typeof RUNNER_WORKFLOW_IDS[number];
export type RunnerWorkflowProvider = "codex" | "opencode" | "acpx";
export type RunnerWorkflowExecutionClassification =
  | "completed"
  | "candidate_failure"
  | "infrastructure_failure"
  | "skipped";

export type RunnerWorkflowStep =
  | { kind: "run_start"; taskMode: "ask" | "execute" | "plan" }
  | { kind: "interaction_response"; interaction: "questions" | "suggest_tasks" | "checkbox" | "item_verdicts"; partial?: boolean }
  | { kind: "steer"; delivery: "queued" | "active_turn"; duplicate?: boolean }
  | { kind: "review_decision"; decision: "approve" | "reject" }
  | { kind: "permission_decision"; decision: "allow_once" | "accept_for_session" | "deny" }
  | { kind: "cancel"; actor: "operator" | "control_plane" }
  | { kind: "process_restart"; phase: "provider_turn" | "semantic_result" | "finalization" }
  | { kind: "child_completion"; childProvider: RunnerWorkflowProvider };

export interface RunnerWorkflowTraceExpectation {
  capture: "on" | "off" | "either";
  digestVerified?: boolean;
  ordered?: boolean;
  dispositions?: Array<"mapped" | "generic" | "ignored" | "rejected" | "operator_only">;
  lineage?: Array<"one_to_one" | "one_to_many" | "many_to_one">;
}

export interface RunnerWorkflowAssertions {
  issueStatus?: "todo" | "in_progress" | "blocked" | "in_review" | "done" | "cancelled";
  runStatus?: "succeeded" | "failed" | "cancelled" | "yielded";
  semanticDisposition?: "done" | "needs_review" | "blocked" | "yielded";
  maxAttempts?: number;
  maxRuns?: number;
  recoveryOwner?: "none" | "agent" | "human" | "board";
  commentCount?: number;
  responseSource?: "existing_issue_comment" | "final_agent_message" | "semantic_result_summary" | "adapter_final" | "none";
  orderedMarkers?: string[];
  requiredPrpEventTypes?: string[];
  forbiddenPrpEventTypes?: string[];
  requiredActivityFamilies?: string[];
  artifactDigests?: string[];
  requiredOperationIds?: string[];
  trace?: RunnerWorkflowTraceExpectation;
}

export interface RunnerWorkflowEvalCase {
  schema: typeof RUNNER_WORKFLOW_EVAL_CASE_SCHEMA;
  id: RunnerWorkflowId;
  title: string;
  version: 1;
  tags: string[];
  providers: RunnerWorkflowProvider[];
  steps: RunnerWorkflowStep[];
  assertions: RunnerWorkflowAssertions;
}

export interface RunnerWorkflowCheck {
  id: string;
  passed: boolean;
  reason?: string;
  evidenceIds?: string[];
}

export interface RunnerWorkflowLifecycleEvidence {
  checks: RunnerWorkflowCheck[];
  issueStatus?: string;
  runStatus?: string;
  semanticDisposition?: string;
  attempts?: number;
  runs?: number;
  recoveryOwner?: string;
}

export interface RunnerWorkflowContinuationEvidence {
  checks: RunnerWorkflowCheck[];
  wakeReasons?: string[];
  consumedInputIds?: string[];
  sessionPolicy?: "same_session" | "approved_replacement" | "new_session";
  repeatedWorkSignals?: string[];
}

export interface RunnerWorkflowPresentationEvidence {
  checks: RunnerWorkflowCheck[];
  responseSource?: string;
  commentCount?: number;
  orderedMarkers?: string[];
  visibleActivityFamilies?: string[];
  terminalLabel?: string;
}

export interface RunnerWorkflowTraceEvidence {
  capture: "on" | "off";
  frameCount: number;
  byteCount: number;
  digestVerified: boolean;
  ordered: boolean;
  dispositions: string[];
  lineage: string[];
  traceRef?: string;
}

export interface RunnerWorkflowMetrics {
  timeToFirstVisibleProgressMs?: number;
  settlementMs?: number;
  attempts: number;
  toolCount: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface RunnerWorkflowFailure {
  code: string;
  category: "candidate" | "provider" | "qualification" | "orchestration";
  retryable: boolean;
  message: string;
}

export interface RunnerWorkflowObservation {
  schema: typeof RUNNER_WORKFLOW_OBSERVATION_SCHEMA;
  caseId: RunnerWorkflowId;
  candidateId: string;
  provider: RunnerWorkflowProvider;
  classification: RunnerWorkflowExecutionClassification;
  base: EvalObservation;
  lifecycle: RunnerWorkflowLifecycleEvidence;
  continuation: RunnerWorkflowContinuationEvidence;
  presentation: RunnerWorkflowPresentationEvidence;
  traceLineage: RunnerWorkflowTraceEvidence;
  metrics: RunnerWorkflowMetrics;
  observedPrpEventTypes: string[];
  artifactDigests: string[];
  failure?: RunnerWorkflowFailure;
}

export type RunnerWorkflowDimensionKey =
  | "hard_invariants"
  | "lifecycle_integrity"
  | "semantic_outcome"
  | "trajectory_restraint"
  | "trace_completeness"
  | "quality_efficiency"
  | "continuation_integrity"
  | "presentation_fidelity";

export const RUNNER_WORKFLOW_DIMENSION_KEYS: readonly RunnerWorkflowDimensionKey[] = [
  "hard_invariants",
  "lifecycle_integrity",
  "semantic_outcome",
  "trajectory_restraint",
  "trace_completeness",
  "quality_efficiency",
  "continuation_integrity",
  "presentation_fidelity",
] as const;

export interface RunnerWorkflowDimensionScore {
  dimension: RunnerWorkflowDimensionKey;
  score: number | null;
  passed: boolean | null;
  gate: boolean;
  weight: number;
  reasons: string[];
}

export interface RunnerWorkflowEvalScorecard {
  schema: typeof RUNNER_WORKFLOW_SCORECARD_SCHEMA;
  bundleId: string;
  caseId: RunnerWorkflowId;
  candidateId: string;
  classification: RunnerWorkflowExecutionClassification;
  dimensions: Record<RunnerWorkflowDimensionKey, RunnerWorkflowDimensionScore>;
  overall: {
    score: number | null;
    gatePassed: boolean | null;
    passed: boolean | null;
  };
}

export class RunnerWorkflowContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerWorkflowContractError";
  }
}

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export function assertRunnerWorkflowEvalCase(value: RunnerWorkflowEvalCase): void {
  if (value.schema !== RUNNER_WORKFLOW_EVAL_CASE_SCHEMA || value.version !== 1) {
    throw new RunnerWorkflowContractError(`unsupported workflow case schema for ${value.id}`);
  }
  if (!(RUNNER_WORKFLOW_IDS as readonly string[]).includes(value.id)) {
    throw new RunnerWorkflowContractError(`unknown workflow id: ${value.id}`);
  }
  if (value.title.trim().length === 0 || value.steps.length === 0 || value.providers.length === 0) {
    throw new RunnerWorkflowContractError(`workflow ${value.id} is missing title, steps, or providers`);
  }
  if (!unique(value.tags) || !unique(value.providers)) {
    throw new RunnerWorkflowContractError(`workflow ${value.id} contains duplicate catalog values`);
  }
  if ((value.assertions.requiredPrpEventTypes ?? []).some((eventType) =>
    value.assertions.forbiddenPrpEventTypes?.includes(eventType))) {
    throw new RunnerWorkflowContractError(`workflow ${value.id} requires and forbids the same PRP event`);
  }
}

export function assertRunnerWorkflowObservation(value: RunnerWorkflowObservation): void {
  if (value.schema !== RUNNER_WORKFLOW_OBSERVATION_SCHEMA) {
    throw new RunnerWorkflowContractError(`unsupported workflow observation schema for ${value.caseId}`);
  }
  if (!(RUNNER_WORKFLOW_IDS as readonly string[]).includes(value.caseId) || value.candidateId.trim().length === 0) {
    throw new RunnerWorkflowContractError("workflow observation identity is invalid");
  }
  for (const [name, checks] of [
    ["lifecycle", value.lifecycle.checks],
    ["continuation", value.continuation.checks],
    ["presentation", value.presentation.checks],
  ] as const) {
    if (checks.length === 0 || !unique(checks.map((check) => check.id))) {
      throw new RunnerWorkflowContractError(`${value.caseId} ${name} checks must be non-empty and unique`);
    }
  }
  if (["infrastructure_failure", "skipped"].includes(value.classification) && value.failure === undefined) {
    throw new RunnerWorkflowContractError(`${value.caseId} ${value.classification} requires failure metadata`);
  }
  if (value.failure?.message.match(/\b(?:sk-[A-Za-z0-9]{16,}|Bearer\s+\S{16,})\b/i)) {
    throw new RunnerWorkflowContractError(`${value.caseId} failure metadata contains secret-shaped data`);
  }
}
