import type { HeartbeatRunStatus, RunLivenessState } from "@paperclipai/shared";

export const AGENT_MANAGER_ACTIVITY_ACTIONS = {
  evaluate: "agent_manager.evaluate",
  reflect: "agent_manager.reflect",
  escalate: "agent_manager.escalate",
} as const;

export type EvaluationTrigger = "run_succeeded" | "run_failed" | "needs_followup";

export type EvaluationOutcome = "pass" | "reflect" | "escalate" | "skipped" | "judge_error";

export type RunEvaluationEvent = {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  runStatus: HeartbeatRunStatus;
  livenessState: RunLivenessState | null;
  trigger: EvaluationTrigger;
};

export type JudgeCorrection = {
  priority: "must" | "should";
  instruction: string;
};

export type JudgeCriteriaResult = {
  id: string;
  met: boolean;
  note: string;
};

export type JudgeResult = {
  score: number;
  rationale: string;
  criteriaResults: JudgeCriteriaResult[];
  corrections: JudgeCorrection[];
  hardFailure: boolean;
  hardFailureReason?: string;
};

export type JudgeInput = {
  issueTitle: string;
  issueDescription: string | null;
  issueStatus: string;
  acceptanceCriteria: Array<{ id: string; description: string }>;
  runOutputSummary: string;
  priorReflections: Array<{ score: number | null; rationale: string | null; attempt: number }>;
};

export type JudgeInvokeResult = {
  result: JudgeResult;
  judgeModel: string | null;
  latencyMs: number;
};

export type JudgeInvoker = (input: {
  companyId: string;
  supervisorAgentId: string;
  judgeModelProfile: string;
  judgeInput: JudgeInput;
}) => Promise<JudgeInvokeResult>;

export type CompanyAgentManagerSettingsRow = {
  enabled: boolean;
  supervisorAgentId: string | null;
  escalationAgentId: string | null;
  judgeModelProfile: string;
  scoreThreshold: number;
  maxReflectionAttempts: number;
  evaluateFailedRuns: boolean;
  evaluateNeedsFollowup: boolean;
};

export type ShouldEvaluateInput = {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  trigger: EvaluationTrigger;
  issueWorkMode: string | null;
  settings: CompanyAgentManagerSettingsRow | null;
  hasActiveRecovery: boolean;
  hasExistingEvaluation: boolean;
  assigneeBudgetBlocked: boolean;
  supervisedAgentExcluded: boolean;
};

export type ApplyJudgeOutcomeResult =
  | { action: "pass"; evaluationId: string }
  | { action: "reflect"; evaluationId: string; commentId: string }
  | { action: "escalate"; evaluationId: string; commentId: string }
  | { action: "judge_error"; evaluationId: string };

export type EnqueueWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
    idempotencyKey?: string;
  },
) => Promise<unknown | null>;

export function resolveEvaluationTrigger(input: {
  status: string;
  livenessState: RunLivenessState | null;
}): EvaluationTrigger | null {
  if (input.status === "cancelled" || input.status === "interrupted") return null;
  if (input.livenessState === "needs_followup") return "needs_followup";
  if (input.status === "succeeded") return "run_succeeded";
  if (input.status === "failed" || input.status === "timed_out") return "run_failed";
  return null;
}
