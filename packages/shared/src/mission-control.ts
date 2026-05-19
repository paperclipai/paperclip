import { z } from "zod";
import type { IssuePriority, IssueStatus } from "./constants.js";

export const MISSION_CONTROL_VALIDATOR_VERDICTS = ["PASS", "REQUEST_CHANGES", "ESCALATE"] as const;
export type MissionControlValidatorVerdict = (typeof MISSION_CONTROL_VALIDATOR_VERDICTS)[number];

export const MISSION_CONTROL_RISK_CLASSES = ["low", "medium", "high", "critical"] as const;
export type MissionControlRiskClass = (typeof MISSION_CONTROL_RISK_CLASSES)[number];

export const MISSION_CONTROL_ACTION_RISK_LEVELS = [
  "no_side_effect",
  "local_only",
  "paperclip_only",
  "external_dry_run",
  "external_live",
  "destructive",
] as const;
export type MissionControlActionRiskLevel = (typeof MISSION_CONTROL_ACTION_RISK_LEVELS)[number];

export const MISSION_CONTROL_APPROVAL_GATES = ["none", "lead", "validator", "board", "compliance"] as const;
export type MissionControlApprovalGate = (typeof MISSION_CONTROL_APPROVAL_GATES)[number];

export const MISSION_CONTROL_SIDE_EFFECT_APPROVAL_STATUSES = ["requested", "approved", "denied", "expired"] as const;
export type MissionControlSideEffectApprovalStatus =
  (typeof MISSION_CONTROL_SIDE_EFFECT_APPROVAL_STATUSES)[number];

export const MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY = "orchestration-contract" as const;
export const MISSION_CONTROL_VALIDATOR_REPORT_DOCUMENT_KEY = "validator-report" as const;

export const MISSION_CONTROL_ORCHESTRATION_WORKSTREAM_STATUSES = [
  "planned",
  "delegated",
  "in_progress",
  "done",
  "blocked",
  "cancelled",
] as const;
export type MissionControlOrchestrationWorkstreamStatus =
  (typeof MISSION_CONTROL_ORCHESTRATION_WORKSTREAM_STATUSES)[number];

export const MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS = [
  "validation-contract",
  MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY,
  "worker-handoff",
  MISSION_CONTROL_VALIDATOR_REPORT_DOCUMENT_KEY,
] as const;
export type MissionControlDefaultRequiredDocumentKey =
  (typeof MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS)[number];

const textArraySchema = z.array(z.string().trim().min(1));
const nonEmptyTextArraySchema = textArraySchema.default([]);
const requiredTextArraySchema = textArraySchema.min(1);
const missionControlDocumentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

export const MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY = "ceo-loop-decision" as const;

export const MISSION_CONTROL_AUTONOMOUS_LOOP_DECISIONS = [
  "next_iteration",
  "goal_reached",
  "blocked",
  "approval_required",
  "partial_completion",
  "goal_revision",
  "failed",
] as const;
export type MissionControlAutonomousLoopDecision =
  (typeof MISSION_CONTROL_AUTONOMOUS_LOOP_DECISIONS)[number];

export const MISSION_CONTROL_AUTONOMOUS_LOOP_STATES = [
  "goal_created",
  "planning",
  "executing",
  "validating",
  "ceo_review",
  "next_iteration",
  "goal_reached",
  "blocked",
  "approval_required",
  "partial_completion",
  "goal_revision",
  "failed",
] as const;
export type MissionControlAutonomousLoopState =
  (typeof MISSION_CONTROL_AUTONOMOUS_LOOP_STATES)[number];

export const MISSION_CONTROL_AUTONOMOUS_LOOP_REPORT_EVENTS = [
  "goal_reached",
  "partial_completion",
  "blocker",
  "approval_required",
  "periodic_checkpoint_required",
  "budget_exceeded",
  "runtime_exceeded",
  "iteration_exceeded",
  "failed",
  "repeated_failure",
  "elevated_risk",
] as const;
export type MissionControlAutonomousLoopReportEvent =
  (typeof MISSION_CONTROL_AUTONOMOUS_LOOP_REPORT_EVENTS)[number];

export const MISSION_CONTROL_AUTONOMOUS_LOOP_CEO_APPROVALS = [
  "research",
  "specs",
  "local_code_changes",
  "tests",
  "paperclip_comments",
  "dry_runs",
  "passive_ci_artifacts",
] as const;
export type MissionControlAutonomousLoopCeoApproval =
  (typeof MISSION_CONTROL_AUTONOMOUS_LOOP_CEO_APPROVALS)[number];

export const MISSION_CONTROL_AUTONOMOUS_LOOP_USER_APPROVALS = [
  "live_external_action",
  "destructive_action",
  "production_deploy",
  "protected_branch_merge",
  "spend_money",
  "account_or_proxy_change",
] as const;
export type MissionControlAutonomousLoopUserApproval =
  (typeof MISSION_CONTROL_AUTONOMOUS_LOOP_USER_APPROVALS)[number];

export const missionControlAutonomousLoopPolicySchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    controller: z.literal("CEO").optional().default("CEO"),
    goal: z.string().trim().min(1).optional().nullable().default(null),
    state: z.enum(MISSION_CONTROL_AUTONOMOUS_LOOP_STATES).optional().default("goal_created"),
    startedAt: z.string().datetime().optional().nullable().default(null),
    iteration: z.number().int().nonnegative().max(1000).optional().default(0),
    maxIterations: z.number().int().positive().max(100).optional().nullable().default(null),
    maxRuntimeHours: z.number().positive().max(24 * 90).optional().nullable().default(null),
    maxDecisionAgeMinutes: z.number().positive().max(24 * 90 * 60).optional().nullable().default(60),
    userApprovalEveryNIterations: z.number().int().positive().max(1000).optional().nullable().default(null),
    maxBudgetCents: z.number().int().positive().optional().nullable().default(null),
    requireValidatorPass: z.boolean().optional().default(true),
    reportToUserOnlyOn: z
      .array(z.enum(MISSION_CONTROL_AUTONOMOUS_LOOP_REPORT_EVENTS))
      .optional()
      .default([
        "goal_reached",
        "partial_completion",
        "blocker",
        "approval_required",
        "periodic_checkpoint_required",
        "runtime_exceeded",
        "iteration_exceeded",
        "failed",
      ]),
    ceoCanApprove: z
      .array(z.enum(MISSION_CONTROL_AUTONOMOUS_LOOP_CEO_APPROVALS))
      .optional()
      .default([
        "research",
        "specs",
        "local_code_changes",
        "tests",
        "paperclip_comments",
        "dry_runs",
        "passive_ci_artifacts",
      ]),
    userApprovalRequired: z
      .array(z.enum(MISSION_CONTROL_AUTONOMOUS_LOOP_USER_APPROVALS))
      .optional()
      .default([
        "live_external_action",
        "destructive_action",
        "production_deploy",
        "protected_branch_merge",
        "spend_money",
        "account_or_proxy_change",
      ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    if (!value.goal) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Autonomous loops require a goal", path: ["goal"] });
    }
    if (!value.startedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Autonomous loops require startedAt for runtime limits",
        path: ["startedAt"],
      });
    }
    if (!value.maxIterations) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Autonomous loops require maxIterations",
        path: ["maxIterations"],
      });
    }
    if (!value.maxRuntimeHours) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Autonomous loops require maxRuntimeHours",
        path: ["maxRuntimeHours"],
      });
    }
  });
export type MissionControlAutonomousLoopPolicy = z.infer<typeof missionControlAutonomousLoopPolicySchema>;

const missionControlCeoLoopNextTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(20000).optional().nullable().default(null),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    assigneeHint: z.string().trim().min(1).max(160).optional().nullable().default(null),
    safeToRunWithoutUserApproval: z.boolean(),
  })
  .strict();

const missionControlCeoLoopHardGateSchema = z
  .object({
    required: z.boolean(),
    reason: z.string().trim().min(1).max(4000).optional().nullable().default(null),
    category: z.enum(MISSION_CONTROL_AUTONOMOUS_LOOP_USER_APPROVALS).optional().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.required && !value.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Required hard gates need a reason", path: ["reason"] });
    }
  });

export const missionControlCeoLoopDecisionSchema = z
  .object({
    version: z.literal(1),
    iteration: z.number().int().nonnegative().max(1000),
    decision: z.enum(MISSION_CONTROL_AUTONOMOUS_LOOP_DECISIONS),
    decisionWrittenAt: z.string().datetime().optional().nullable().default(null),
    rationale: z.string().trim().min(1).max(4000),
    revisedGoal: z.string().trim().min(1).max(4000).optional().nullable().default(null),
    nextTask: missionControlCeoLoopNextTaskSchema.optional().nullable().default(null),
    hardGate: missionControlCeoLoopHardGateSchema.optional().nullable().default(null),
    validatorVerdict: z.enum(MISSION_CONTROL_VALIDATOR_VERDICTS).optional().nullable().default(null),
    evidence: nonEmptyTextArraySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "next_iteration" && !value.nextTask) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "next_iteration decisions require nextTask",
        path: ["nextTask"],
      });
    }
    if (value.decision === "approval_required" && !value.hardGate?.required) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "approval_required decisions require a hardGate",
        path: ["hardGate"],
      });
    }
    if (value.decision === "partial_completion") {
      if (!value.nextTask) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "partial_completion decisions require nextTask",
          path: ["nextTask"],
        });
      }
      if (!value.nextTask?.assigneeHint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "partial_completion decisions require a nextTask assigneeHint",
          path: ["nextTask", "assigneeHint"],
        });
      }
      if (value.nextTask?.safeToRunWithoutUserApproval !== false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "partial_completion handoffs must require user approval",
          path: ["nextTask", "safeToRunWithoutUserApproval"],
        });
      }
    }
    if (value.decision === "goal_revision" && !value.revisedGoal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "goal_revision decisions require revisedGoal",
        path: ["revisedGoal"],
      });
    }
    if (
      value.nextTask &&
      !value.nextTask.safeToRunWithoutUserApproval &&
      value.decision !== "approval_required" &&
      value.decision !== "partial_completion"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unsafe next tasks must use approval_required",
        path: ["nextTask", "safeToRunWithoutUserApproval"],
      });
    }
  });
export type MissionControlCeoLoopDecision = z.infer<typeof missionControlCeoLoopDecisionSchema>;

export const missionControlOrchestrationChildWorkstreamSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    objective: z.string().trim().min(1).max(4000),
    issueId: z.string().trim().min(1).max(160).optional().nullable().default(null),
    assigneeAgentId: z.string().trim().min(1).max(160).optional().nullable().default(null),
    acceptanceCriteria: requiredTextArraySchema,
    requiredArtifacts: requiredTextArraySchema,
    handoffDocumentKeys: z.array(missionControlDocumentKeySchema).min(1).default(["worker-handoff"]),
    status: z.enum(MISSION_CONTROL_ORCHESTRATION_WORKSTREAM_STATUSES).optional().default("planned"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.issueId && !value.assigneeAgentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Child workstreams require issueId or assigneeAgentId",
        path: ["issueId"],
      });
    }
  });
export type MissionControlOrchestrationChildWorkstream = z.infer<
  typeof missionControlOrchestrationChildWorkstreamSchema
>;

export const missionControlOrchestrationContractSchema = z
  .object({
    version: z.literal(1),
    leadAgentId: z.string().trim().min(1).max(160),
    validatorAgentId: z.string().trim().min(1).max(160),
    reporterAgentId: z.string().trim().min(1).max(160).optional().nullable().default(null),
    childWorkstreams: z.array(missionControlOrchestrationChildWorkstreamSchema).min(1).max(25),
    finalSummaryDocumentKey: missionControlDocumentKeySchema.optional().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.validatorAgentId === value.leadAgentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Validator must be distinct from the lead",
        path: ["validatorAgentId"],
      });
    }
    value.childWorkstreams.forEach((workstream, index) => {
      if (workstream.assigneeAgentId && workstream.assigneeAgentId === value.validatorAgentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Validator must be distinct from delegated workers",
          path: ["childWorkstreams", index, "assigneeAgentId"],
        });
      }
    });
  });
export type MissionControlOrchestrationContract = z.infer<typeof missionControlOrchestrationContractSchema>;

export const missionControlIssuePolicySchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    riskClass: z.enum(MISSION_CONTROL_RISK_CLASSES).optional().default("medium"),
    requiredDocumentKeys: z
      .array(missionControlDocumentKeySchema)
      .optional()
      .default([...MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS]),
    acceptedValidatorVerdicts: z.array(z.enum(MISSION_CONTROL_VALIDATOR_VERDICTS)).optional().default(["PASS"]),
    maxChildIssues: z.number().int().positive().max(25).optional().nullable().default(null),
    maxIterations: z.number().int().positive().max(20).optional().nullable().default(null),
    liveActionGate: z.enum(MISSION_CONTROL_APPROVAL_GATES).optional().default("board"),
    destructiveActionGate: z.enum(MISSION_CONTROL_APPROVAL_GATES).optional().default("board"),
    autonomousLoop: missionControlAutonomousLoopPolicySchema.optional().nullable().default(null),
  })
  .strict();
export type MissionControlIssuePolicy = z.infer<typeof missionControlIssuePolicySchema>;

export const missionControlValidationContractSchema = z
  .object({
    version: z.literal(1),
    objective: z.string().trim().min(1),
    outOfScope: nonEmptyTextArraySchema,
    passCriteria: requiredTextArraySchema,
    requiredArtifacts: nonEmptyTextArraySchema,
    allowedTools: nonEmptyTextArraySchema,
    gatedActions: nonEmptyTextArraySchema,
    riskClass: z.enum(MISSION_CONTROL_RISK_CLASSES).default("medium"),
    reportingDestination: z.string().trim().min(1).optional().nullable().default(null),
  })
  .strict();
export type MissionControlValidationContract = z.infer<typeof missionControlValidationContractSchema>;

export const missionControlWorkerHandoffSchema = z
  .object({
    version: z.literal(1),
    completed: requiredTextArraySchema,
    notDone: nonEmptyTextArraySchema,
    commands: requiredTextArraySchema,
    sources: nonEmptyTextArraySchema,
    artifacts: requiredTextArraySchema,
    checks: requiredTextArraySchema,
    risks: nonEmptyTextArraySchema,
    nextStep: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type MissionControlWorkerHandoff = z.infer<typeof missionControlWorkerHandoffSchema>;

export const missionControlValidatorReportSchema = z
  .object({
    version: z.literal(1),
    writtenByAgentId: z.string().trim().min(1),
    verdict: z.enum(MISSION_CONTROL_VALIDATOR_VERDICTS),
    completionScore: z.number().min(0).max(10),
    criteriaChecked: requiredTextArraySchema,
    evidence: requiredTextArraySchema,
    hallucinationFlags: nonEmptyTextArraySchema,
    regressionChecks: nonEmptyTextArraySchema,
    blockingIssues: nonEmptyTextArraySchema,
    exactFixIfFailed: z.string().trim().min(1).optional().nullable().default(null),
  })
  .strict();
export type MissionControlValidatorReport = z.infer<typeof missionControlValidatorReportSchema>;

export const missionControlOutcomeLearningCardSchema = z
  .object({
    version: z.literal(1),
    result: z.enum(MISSION_CONTROL_VALIDATOR_VERDICTS),
    acceptedDeliverables: nonEmptyTextArraySchema,
    failureModes: nonEmptyTextArraySchema,
    memoryCandidates: nonEmptyTextArraySchema,
    skillOrPromptCandidates: nonEmptyTextArraySchema,
    promoted: z.boolean().optional().default(false),
  })
  .strict();
export type MissionControlOutcomeLearningCard = z.infer<typeof missionControlOutcomeLearningCardSchema>;

export const missionControlSideEffectApprovalEnvelopeSchema = z
  .object({
    version: z.literal(1),
    tool: z.string().trim().min(1),
    action: z.string().trim().min(1),
    actionRiskLevel: z.enum(MISSION_CONTROL_ACTION_RISK_LEVELS),
    requiredApprovalGate: z.enum(MISSION_CONTROL_APPROVAL_GATES),
    status: z.enum(MISSION_CONTROL_SIDE_EFFECT_APPROVAL_STATUSES).default("requested"),
    requestedByAgentId: z.string().trim().min(1).optional().nullable().default(null),
    approvedByUserId: z.string().trim().min(1).optional().nullable().default(null),
    approvedByAgentId: z.string().trim().min(1).optional().nullable().default(null),
    approvedAt: z.string().datetime().optional().nullable().default(null),
    expiresAt: z.string().datetime().optional().nullable().default(null),
    dryRunEvidence: nonEmptyTextArraySchema,
    constraints: nonEmptyTextArraySchema,
  })
  .strict();
export type MissionControlSideEffectApprovalEnvelope = z.infer<
  typeof missionControlSideEffectApprovalEnvelopeSchema
>;

export type MissionControlCompletionGateIssue = {
  priority: IssuePriority | string;
  assigneeAgentId?: string | null;
  executionPolicy?: unknown;
};

export type MissionControlCompletionGateDocument = {
  key: string;
  body?: string | null;
  createdByAgentId?: string | null;
  updatedByAgentId?: string | null;
  updatedAt?: string | Date | null;
};

export type MissionControlAutonomousLoopGateReason =
  | "autonomous_loop_disabled"
  | "missing_ceo_loop_decision"
  | "invalid_ceo_loop_decision"
  | "ceo_loop_iteration_mismatch"
  | "ceo_loop_decision_stale"
  | "ceo_loop_decision_from_future"
  | "runtime_exceeded"
  | "iteration_exceeded"
  | "periodic_checkpoint_required"
  | "partial_completion"
  | "approval_required"
  | "validator_pass_required"
  | "autonomous_loop_not_complete"
  | "allowed";

export type MissionControlAutonomousLoopGateResult = {
  allowed: boolean;
  enabled: boolean;
  policy: MissionControlIssuePolicy | null;
  autonomousLoopPolicy: MissionControlAutonomousLoopPolicy | null;
  missingDocumentKeys: string[];
  ceoLoopDecision: MissionControlCeoLoopDecision | null;
  requiredApprovalGate: MissionControlApprovalGate;
  reason: MissionControlAutonomousLoopGateReason;
};

export type MissionControlCompletionGateResult = {
  allowed: boolean;
  enabled: boolean;
  policy: MissionControlIssuePolicy | null;
  missingDocumentKeys: string[];
  validatorVerdict: MissionControlValidatorVerdict | null;
  ceoLoopDecision: MissionControlCeoLoopDecision | null;
  orchestrationContract: MissionControlOrchestrationContract | null;
  requiredApprovalGate: MissionControlApprovalGate;
  reason:
    | "mission_control_disabled"
    | "missing_documents"
    | "invalid_orchestration_contract"
    | "orchestration_workstreams_incomplete"
    | "validator_not_passed"
    | "validator_self_attested"
    | "validator_identity_mismatch"
    | "missing_ceo_loop_decision"
    | "invalid_ceo_loop_decision"
    | "ceo_loop_iteration_mismatch"
    | "ceo_loop_decision_stale"
    | "ceo_loop_decision_from_future"
    | "runtime_exceeded"
    | "iteration_exceeded"
    | "periodic_checkpoint_required"
    | "partial_completion"
    | "approval_required"
    | "validator_pass_required"
    | "autonomous_loop_not_complete"
    | "allowed";
};

function readMissionControlPolicy(executionPolicy: unknown): MissionControlIssuePolicy | null {
  if (!executionPolicy || typeof executionPolicy !== "object") return null;
  const maybePolicy = (executionPolicy as { missionControl?: unknown }).missionControl;
  if (!maybePolicy || typeof maybePolicy !== "object") return null;
  const parsed = missionControlIssuePolicySchema.safeParse(maybePolicy);
  return parsed.success ? parsed.data : null;
}

function requiredGateForRisk(policy: MissionControlIssuePolicy): MissionControlApprovalGate {
  if (policy.riskClass === "critical") return "board";
  if (policy.riskClass === "high") return "board";
  if (policy.riskClass === "medium") return "validator";
  return "lead";
}

function jsonDocumentCandidatesFromBody(body: string): string[] {
  const trimmed = body.trim();
  const candidates = [trimmed];
  const pushCandidate = (candidate: string) => {
    const normalized = candidate.trim();
    if (!normalized || candidates.some((existing) => existing === normalized)) return;
    candidates.push(normalized);
  };

  const fencedBlockPattern = /```(?:[\w-]+)?\s*([\s\S]*?)\s*```/gi;
  trimmed.replace(fencedBlockPattern, (_match, fencedBody: string) => {
    pushCandidate(fencedBody);
    return "";
  });

  return candidates;
}

function parseMarkdownValidatorVerdict(body: string): MissionControlValidatorVerdict | null {
  const trimmed = body.trim();
  const exactVerdict = trimmed.toUpperCase();
  if (exactVerdict === "PASS" || exactVerdict === "REQUEST_CHANGES" || exactVerdict === "ESCALATE") {
    return exactVerdict as MissionControlValidatorVerdict;
  }

  const verdictPatterns = [
    /^\s*(?:validator\s+)?verdict\s*[:=-]\s*(PASS|REQUEST_CHANGES|ESCALATE)\b/im,
    /^\s*\|\s*(?:validator\s+)?verdict\s*\|\s*(PASS|REQUEST_CHANGES|ESCALATE)\s*\|/im,
    /^\s*#{1,6}\s*(?:validator\s+)?verdict\s*\n\s*(PASS|REQUEST_CHANGES|ESCALATE)\b/im,
  ];

  for (const pattern of verdictPatterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return match[1] as MissionControlValidatorVerdict;
  }

  return null;
}

export function parseMissionControlValidatorReportFromBody(
  body: string | null | undefined,
  options?: { writtenByAgentId?: string | null },
): MissionControlValidatorReport | null {
  if (!body?.trim()) return null;
  const trimmed = body.trim();
  const trustedWrittenByAgentId = options?.writtenByAgentId?.trim() || null;
  let sawJsonCandidate = false;
  for (const candidate of jsonDocumentCandidatesFromBody(trimmed)) {
    try {
      const parsedJson = JSON.parse(candidate) as unknown;
      sawJsonCandidate = true;
      const reportCandidate =
        trustedWrittenByAgentId && parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)
          ? { ...parsedJson, writtenByAgentId: trustedWrittenByAgentId }
          : parsedJson;
      const parsedReport = missionControlValidatorReportSchema.safeParse(reportCandidate);
      if (parsedReport.success) return parsedReport.data;
    } catch {
      // Markdown reports are supported below via a conservative verdict scan.
    }
  }

  if (sawJsonCandidate) return null;
  const verdict = parseMarkdownValidatorVerdict(trimmed);
  if (!verdict || !trustedWrittenByAgentId) return null;
  return {
    version: 1,
    writtenByAgentId: trustedWrittenByAgentId,
    verdict,
    completionScore: verdict === "PASS" ? 8 : 0,
    criteriaChecked: ["markdown validator verdict present"],
    evidence: ["validator-report document body"],
    hallucinationFlags: [],
    regressionChecks: [],
    blockingIssues: verdict === "PASS" ? [] : ["validator did not pass"],
    exactFixIfFailed: null,
  };
}

const INVALID_ORCHESTRATION_CONTRACT = "__invalid_orchestration_contract__" as const;

function parseOrchestrationContractFromBody(
  body: string | null | undefined,
): MissionControlOrchestrationContract | typeof INVALID_ORCHESTRATION_CONTRACT | null {
  if (!body?.trim()) return null;
  const trimmed = body.trim();
  for (const candidate of jsonDocumentCandidatesFromBody(trimmed)) {
    try {
      const parsedJson = JSON.parse(candidate) as unknown;
      const parsedContract = missionControlOrchestrationContractSchema.safeParse(parsedJson);
      if (parsedContract.success) return parsedContract.data;
    } catch {
      // Orchestration contracts must be structured JSON; fall through to invalid.
    }
  }
  return INVALID_ORCHESTRATION_CONTRACT;
}

const INVALID_CEO_LOOP_DECISION = "__invalid_ceo_loop_decision__" as const;

function parseCeoLoopDecisionFromBody(
  body: string | null | undefined,
): MissionControlCeoLoopDecision | typeof INVALID_CEO_LOOP_DECISION | null {
  if (!body?.trim()) return null;
  const trimmed = body.trim();
  for (const candidate of jsonDocumentCandidatesFromBody(trimmed)) {
    try {
      const parsedJson = JSON.parse(candidate);
      const parsedDecision = missionControlCeoLoopDecisionSchema.safeParse(parsedJson);
      if (parsedDecision.success) return parsedDecision.data;
    } catch {
      // Fall through to invalid; CEO loop decisions must be structured JSON.
    }
  }
  return INVALID_CEO_LOOP_DECISION;
}

function dateValueMs(value: string | Date | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  return value ? Date.parse(value) : Number.NaN;
}

export function evaluateMissionControlAutonomousLoopGate(input: {
  issue: MissionControlCompletionGateIssue;
  documents: MissionControlCompletionGateDocument[];
  validatorVerdict?: MissionControlValidatorVerdict | null;
  now?: string | Date;
}): MissionControlAutonomousLoopGateResult {
  const policy = readMissionControlPolicy(input.issue.executionPolicy);
  const autonomousLoopPolicy = policy?.autonomousLoop ?? null;
  if (!policy?.enabled || !autonomousLoopPolicy?.enabled) {
    return {
      allowed: true,
      enabled: false,
      policy: policy?.enabled ? policy : null,
      autonomousLoopPolicy: null,
      missingDocumentKeys: [],
      ceoLoopDecision: null,
      requiredApprovalGate: "none",
      reason: "autonomous_loop_disabled",
    };
  }

  const docsByKey = new Map(input.documents.map((doc) => [doc.key.trim().toLowerCase(), doc]));
  const decisionDocument = docsByKey.get(MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY);
  if (!decisionDocument) {
    return {
      allowed: false,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY],
      ceoLoopDecision: null,
      requiredApprovalGate: "board",
      reason: "missing_ceo_loop_decision",
    };
  }

  const ceoLoopDecision = parseCeoLoopDecisionFromBody(decisionDocument.body);
  if (!ceoLoopDecision || ceoLoopDecision === INVALID_CEO_LOOP_DECISION) {
    return {
      allowed: false,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [],
      ceoLoopDecision: null,
      requiredApprovalGate: "board",
      reason: "invalid_ceo_loop_decision",
    };
  }

  const decisionContinuesLoop = ceoLoopDecision.decision === "next_iteration";
  const nowMs = dateValueMs(input.now ?? new Date());
  if (ceoLoopDecision.iteration < autonomousLoopPolicy.iteration) {
    return {
      allowed: false,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [],
      ceoLoopDecision,
      requiredApprovalGate: "board",
      reason: "ceo_loop_decision_stale",
    };
  }

  if (ceoLoopDecision.iteration > autonomousLoopPolicy.iteration) {
    return {
      allowed: false,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [],
      ceoLoopDecision,
      requiredApprovalGate: "board",
      reason: "ceo_loop_decision_from_future",
    };
  }

  if (autonomousLoopPolicy.maxDecisionAgeMinutes) {
    const decisionDocumentUpdatedAtMs = dateValueMs(decisionDocument.updatedAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(decisionDocumentUpdatedAtMs)) {
      return {
        allowed: false,
        enabled: true,
        policy,
        autonomousLoopPolicy,
        missingDocumentKeys: [],
        ceoLoopDecision,
        requiredApprovalGate: "board",
        reason: "ceo_loop_decision_stale",
      };
    }

    const decisionAgeMs = nowMs - decisionDocumentUpdatedAtMs;
    if (decisionAgeMs < 0) {
      return {
        allowed: false,
        enabled: true,
        policy,
        autonomousLoopPolicy,
        missingDocumentKeys: [],
        ceoLoopDecision,
        requiredApprovalGate: "board",
        reason: "ceo_loop_decision_from_future",
      };
    }

    if (decisionAgeMs > autonomousLoopPolicy.maxDecisionAgeMinutes * 60 * 1000) {
      return {
        allowed: false,
        enabled: true,
        policy,
        autonomousLoopPolicy,
        missingDocumentKeys: [],
        ceoLoopDecision,
        requiredApprovalGate: "board",
        reason: "ceo_loop_decision_stale",
      };
    }
  }

  const startedAtMs = autonomousLoopPolicy.startedAt ? Date.parse(autonomousLoopPolicy.startedAt) : Number.NaN;
  if (
    decisionContinuesLoop &&
    autonomousLoopPolicy.maxRuntimeHours &&
    Number.isFinite(nowMs) &&
    Number.isFinite(startedAtMs) &&
    nowMs - startedAtMs > autonomousLoopPolicy.maxRuntimeHours * 60 * 60 * 1000
  ) {
    return {
      allowed: false,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [],
      ceoLoopDecision,
      requiredApprovalGate: "board",
      reason: "runtime_exceeded",
    };
  }

  if (
    decisionContinuesLoop &&
    autonomousLoopPolicy.maxIterations &&
    autonomousLoopPolicy.iteration >= autonomousLoopPolicy.maxIterations
  ) {
    return {
      allowed: false,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [],
      ceoLoopDecision,
      requiredApprovalGate: "board",
      reason: "iteration_exceeded",
    };
  }

  if (ceoLoopDecision.hardGate?.required || ceoLoopDecision.decision === "approval_required") {
    return {
      allowed: false,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [],
      ceoLoopDecision,
      requiredApprovalGate: "board",
      reason: "approval_required",
    };
  }

  if (
    decisionContinuesLoop &&
    autonomousLoopPolicy.userApprovalEveryNIterations &&
    autonomousLoopPolicy.iteration > 0 &&
    autonomousLoopPolicy.iteration % autonomousLoopPolicy.userApprovalEveryNIterations === 0
  ) {
    return {
      allowed: false,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [],
      ceoLoopDecision,
      requiredApprovalGate: "board",
      reason: "periodic_checkpoint_required",
    };
  }

  if (ceoLoopDecision.decision === "goal_revision") {
    return {
      allowed: false,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [],
      ceoLoopDecision,
      requiredApprovalGate: "board",
      reason: "approval_required",
    };
  }

  if (ceoLoopDecision.decision === "partial_completion") {
    return {
      allowed: false,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [],
      ceoLoopDecision,
      requiredApprovalGate: "lead",
      reason: "partial_completion",
    };
  }

  if (ceoLoopDecision.decision === "goal_reached") {
    if (autonomousLoopPolicy.requireValidatorPass && input.validatorVerdict !== "PASS") {
      return {
        allowed: false,
        enabled: true,
        policy,
        autonomousLoopPolicy,
        missingDocumentKeys: [],
        ceoLoopDecision,
        requiredApprovalGate: "validator",
        reason: "validator_pass_required",
      };
    }
    return {
      allowed: true,
      enabled: true,
      policy,
      autonomousLoopPolicy,
      missingDocumentKeys: [],
      ceoLoopDecision,
      requiredApprovalGate: "none",
      reason: "allowed",
    };
  }

  return {
    allowed: false,
    enabled: true,
    policy,
    autonomousLoopPolicy,
    missingDocumentKeys: [],
    ceoLoopDecision,
    requiredApprovalGate: "none",
    reason: "autonomous_loop_not_complete",
  };
}

export function evaluateMissionControlCompletionGate(input: {
  issue: MissionControlCompletionGateIssue;
  documents: MissionControlCompletionGateDocument[];
  now?: string | Date;
}): MissionControlCompletionGateResult {
  const policy = readMissionControlPolicy(input.issue.executionPolicy);
  if (!policy?.enabled) {
    return {
      allowed: true,
      enabled: false,
      policy: null,
      missingDocumentKeys: [],
      validatorVerdict: null,
      ceoLoopDecision: null,
      orchestrationContract: null,
      requiredApprovalGate: "none",
      reason: "mission_control_disabled",
    };
  }

  const docsByKey = new Map(input.documents.map((doc) => [doc.key.trim().toLowerCase(), doc]));
  const requiredKeys = policy.requiredDocumentKeys.length > 0
    ? policy.requiredDocumentKeys
    : [...MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS];
  const missingDocumentKeys = requiredKeys.filter((key) => !docsByKey.has(key));
  const validatorDocument = docsByKey.get(MISSION_CONTROL_VALIDATOR_REPORT_DOCUMENT_KEY);
  const validatorReportWriterAgentId = validatorDocument?.updatedByAgentId ?? validatorDocument?.createdByAgentId ?? null;
  const validatorReport = parseMissionControlValidatorReportFromBody(validatorDocument?.body, {
    writtenByAgentId: validatorReportWriterAgentId,
  });
  const validatorVerdict = validatorReport?.verdict ?? null;
  const requiredApprovalGate = requiredGateForRisk(policy);
  const orchestrationDocument = docsByKey.get(MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY);
  const orchestrationContractResult = orchestrationDocument
    ? parseOrchestrationContractFromBody(orchestrationDocument.body)
    : null;
  const orchestrationContract =
    orchestrationContractResult && orchestrationContractResult !== INVALID_ORCHESTRATION_CONTRACT
      ? orchestrationContractResult
      : null;

  if (missingDocumentKeys.length > 0) {
    return {
      allowed: false,
      enabled: true,
      policy,
      missingDocumentKeys,
      validatorVerdict,
      ceoLoopDecision: null,
      orchestrationContract,
      requiredApprovalGate,
      reason: "missing_documents",
    };
  }

  if (orchestrationDocument && (!orchestrationContractResult || orchestrationContractResult === INVALID_ORCHESTRATION_CONTRACT)) {
    return {
      allowed: false,
      enabled: true,
      policy,
      missingDocumentKeys: [],
      validatorVerdict,
      ceoLoopDecision: null,
      orchestrationContract: null,
      requiredApprovalGate,
      reason: "invalid_orchestration_contract",
    };
  }

  if (orchestrationContract) {
    const requiredOrchestrationDocumentKeys = [
      ...orchestrationContract.childWorkstreams.reduce<string[]>(
        (keys, workstream) => [...keys, ...workstream.handoffDocumentKeys],
        [],
      ),
      ...(orchestrationContract.finalSummaryDocumentKey ? [orchestrationContract.finalSummaryDocumentKey] : []),
    ];
    const missingOrchestrationDocumentKeys = requiredOrchestrationDocumentKeys.filter(
      (key, index, keys) => keys.indexOf(key) === index && !docsByKey.has(key),
    );
    if (missingOrchestrationDocumentKeys.length > 0) {
      return {
        allowed: false,
        enabled: true,
        policy,
        missingDocumentKeys: missingOrchestrationDocumentKeys,
        validatorVerdict,
        ceoLoopDecision: null,
        orchestrationContract,
        requiredApprovalGate,
        reason: "missing_documents",
      };
    }

    if (orchestrationContract.childWorkstreams.some((workstream) => workstream.status !== "done")) {
      return {
        allowed: false,
        enabled: true,
        policy,
        missingDocumentKeys: [],
        validatorVerdict,
        ceoLoopDecision: null,
        orchestrationContract,
        requiredApprovalGate,
        reason: "orchestration_workstreams_incomplete",
      };
    }
  }

  if (!validatorVerdict || !policy.acceptedValidatorVerdicts.includes(validatorVerdict)) {
    return {
      allowed: false,
      enabled: true,
      policy,
      missingDocumentKeys: [],
      validatorVerdict,
      ceoLoopDecision: null,
      orchestrationContract,
      requiredApprovalGate,
      reason: "validator_not_passed",
    };
  }

  if (orchestrationContract && validatorReport?.writtenByAgentId) {
    const validatorWriterAgentId = validatorReport.writtenByAgentId.trim();
    const contractValidatorAgentId = orchestrationContract.validatorAgentId.trim();
    const delegatedWorkerAgentIds = orchestrationContract.childWorkstreams
      .map((workstream) => workstream.assigneeAgentId?.trim() || null)
      .filter((agentId): agentId is string => Boolean(agentId));
    if (delegatedWorkerAgentIds.includes(validatorWriterAgentId)) {
      return {
        allowed: false,
        enabled: true,
        policy,
        missingDocumentKeys: [],
        validatorVerdict,
        ceoLoopDecision: null,
        orchestrationContract,
        requiredApprovalGate,
        reason: "validator_self_attested",
      };
    }
    if (validatorWriterAgentId !== contractValidatorAgentId) {
      return {
        allowed: false,
        enabled: true,
        policy,
        missingDocumentKeys: [],
        validatorVerdict,
        ceoLoopDecision: null,
        orchestrationContract,
        requiredApprovalGate,
        reason: "validator_identity_mismatch",
      };
    }
  }

  const assignedWorkerAgentId = input.issue.assigneeAgentId?.trim() || null;
  if (assignedWorkerAgentId && validatorReport?.writtenByAgentId === assignedWorkerAgentId) {
    return {
      allowed: false,
      enabled: true,
      policy,
      missingDocumentKeys: [],
      validatorVerdict,
      ceoLoopDecision: null,
      orchestrationContract,
      requiredApprovalGate,
      reason: "validator_self_attested",
    };
  }

  const autonomousLoopGate = evaluateMissionControlAutonomousLoopGate({
    issue: input.issue,
    documents: input.documents,
    validatorVerdict,
    now: input.now,
  });
  if (autonomousLoopGate.enabled && !autonomousLoopGate.allowed) {
    return {
      allowed: false,
      enabled: true,
      policy,
      missingDocumentKeys: autonomousLoopGate.missingDocumentKeys,
      validatorVerdict,
      ceoLoopDecision: autonomousLoopGate.ceoLoopDecision,
      orchestrationContract,
      requiredApprovalGate: autonomousLoopGate.requiredApprovalGate,
      reason:
        autonomousLoopGate.reason === "autonomous_loop_disabled"
          ? "autonomous_loop_not_complete"
          : autonomousLoopGate.reason,
    };
  }

  return {
    allowed: true,
    enabled: true,
    policy,
    missingDocumentKeys: [],
    validatorVerdict,
    ceoLoopDecision: autonomousLoopGate.ceoLoopDecision,
    orchestrationContract,
    requiredApprovalGate,
    reason: "allowed",
  };
}

export type MissionControlActionRiskInput = {
  tool: string;
  action: string;
};

export type MissionControlActionRisk = {
  tool: string;
  action: string;
  level: MissionControlActionRiskLevel;
  requiredApprovalGate: MissionControlApprovalGate;
  reason: string;
};

const LIVE_EXTERNAL_TOOLS = new Set(["telegram", "x", "twitter", "email", "gmail", "dm-bot", "tg-sender", "stripe"]);
const PAPERCLIP_TOOLS = new Set(["paperclip", "paperclip-api", "paperclip-mcp"]);

function normalizeMissionControlTool(tool: string): string {
  return tool.trim().toLowerCase();
}

function normalizeMissionControlAction(action: string): string {
  return action.trim().toLowerCase().replace(/[_-]+/g, " ");
}

export function classifyMissionControlActionRisk(input: MissionControlActionRiskInput): MissionControlActionRisk {
  const tool = normalizeMissionControlTool(input.tool);
  const action = normalizeMissionControlAction(input.action);
  const risk = (
    level: MissionControlActionRiskLevel,
    requiredApprovalGate: MissionControlApprovalGate,
    reason: string,
  ): MissionControlActionRisk => ({ tool, action, level, requiredApprovalGate, reason });
  const destructivePattern = /\b(rm\s+(?:-?rf|r\s+f)|delete|drop\s+table|truncate|destroy|retire|revoke|purge|format|reset\s+--hard)\b/;
  const livePattern = /\b(send|post|publish|reply|dm|follow|unfollow|like|retweet|deploy|merge|charge|buy|spend|warmup|outreach)\b/;
  const dryRunPattern = /\b(dry[-_ ]?run|preview|simulate|plan)\b/;
  const readOnlyPattern = /\b(read|list|get|search|inspect|query|select|status|stats|test|typecheck|build|lint)\b/;

  if (destructivePattern.test(action)) {
    return risk("destructive", "board", "destructive action keyword");
  }
  if (LIVE_EXTERNAL_TOOLS.has(tool) && livePattern.test(action) && !dryRunPattern.test(action)) {
    return risk("external_live", "board", "live external side effect");
  }
  if (LIVE_EXTERNAL_TOOLS.has(tool) && dryRunPattern.test(action)) {
    return risk("external_dry_run", "lead", "external dry-run");
  }
  if (PAPERCLIP_TOOLS.has(tool)) {
    return risk("paperclip_only", livePattern.test(action) ? "lead" : "none", "Paperclip-local action");
  }
  if (tool === "terminal" || tool === "file" || tool === "git") {
    return risk("local_only", readOnlyPattern.test(action) ? "none" : "lead", "local development action");
  }
  return risk("no_side_effect", "none", "unclassified read-only default");
}

const APPROVAL_GATE_RANK: Record<MissionControlApprovalGate, number> = {
  none: 0,
  lead: 1,
  validator: 2,
  board: 3,
  compliance: 4,
};

export type MissionControlSideEffectApprovalDecision = {
  allowed: boolean;
  requiredApprovalGate: MissionControlApprovalGate;
  matchingEnvelope: MissionControlSideEffectApprovalEnvelope | null;
  reason: "approval_not_required" | "approved" | "missing_approval" | "expired_approval";
};

export function evaluateMissionControlSideEffectApproval(input: {
  actionRisk: MissionControlActionRisk;
  envelopes: MissionControlSideEffectApprovalEnvelope[];
  now?: Date | string;
}): MissionControlSideEffectApprovalDecision {
  const requiredGate = input.actionRisk.requiredApprovalGate;
  if (requiredGate === "none") {
    return {
      allowed: true,
      requiredApprovalGate: requiredGate,
      matchingEnvelope: null,
      reason: "approval_not_required",
    };
  }

  const nowMs = input.now
    ? input.now instanceof Date
      ? input.now.getTime()
      : new Date(input.now).getTime()
    : Date.now();
  let sawExpired = false;
  const matchingEnvelope = input.envelopes.find((envelope) => {
    if (envelope.status !== "approved") return false;
    if (normalizeMissionControlTool(envelope.tool) !== input.actionRisk.tool) return false;
    if (normalizeMissionControlAction(envelope.action) !== input.actionRisk.action) return false;
    if (envelope.actionRiskLevel !== input.actionRisk.level) return false;
    if (APPROVAL_GATE_RANK[envelope.requiredApprovalGate] < APPROVAL_GATE_RANK[requiredGate]) return false;
    if (envelope.expiresAt && new Date(envelope.expiresAt).getTime() <= nowMs) {
      sawExpired = true;
      return false;
    }
    return Boolean(envelope.approvedByUserId || envelope.approvedByAgentId || envelope.approvedAt);
  }) ?? null;

  if (matchingEnvelope) {
    return {
      allowed: true,
      requiredApprovalGate: requiredGate,
      matchingEnvelope,
      reason: "approved",
    };
  }

  return {
    allowed: false,
    requiredApprovalGate: requiredGate,
    matchingEnvelope: null,
    reason: sawExpired ? "expired_approval" : "missing_approval",
  };
}

export type MissionControlScorecardInput = {
  verdict: MissionControlValidatorVerdict;
  reworkCount?: number | null;
  costCents?: number | null;
};

export type MissionControlScorecard = {
  total: number;
  accepted: number;
  requestChanges: number;
  escalated: number;
  firstPassAcceptanceRate: number;
  requestChangesRate: number;
  escalateRate: number;
  totalReworkCount: number;
  totalCostCents: number;
  costPerAcceptedArtifactCents: number | null;
};

function ratio(count: number, total: number) {
  return total > 0 ? count / total : 0;
}

export function summarizeMissionControlScorecard(rows: MissionControlScorecardInput[]): MissionControlScorecard {
  const total = rows.length;
  const accepted = rows.filter((row) => row.verdict === "PASS").length;
  const requestChanges = rows.filter((row) => row.verdict === "REQUEST_CHANGES").length;
  const escalated = rows.filter((row) => row.verdict === "ESCALATE").length;
  const totalReworkCount = rows.reduce((sum, row) => sum + (row.reworkCount ?? 0), 0);
  const totalCostCents = rows.reduce((sum, row) => sum + (row.costCents ?? 0), 0);
  return {
    total,
    accepted,
    requestChanges,
    escalated,
    firstPassAcceptanceRate: ratio(accepted, total),
    requestChangesRate: ratio(requestChanges, total),
    escalateRate: ratio(escalated, total),
    totalReworkCount,
    totalCostCents,
    costPerAcceptedArtifactCents: accepted > 0 ? totalCostCents / accepted : null,
  };
}

export type MissionControlArtifactLivenessInput = {
  status: IssueStatus | string;
  runStatus?: string | null;
  documents: MissionControlCompletionGateDocument[];
  comments: Array<{ body: string; createdAt?: Date | string | null }>;
};

export type MissionControlArtifactLivenessResult = {
  substantive: boolean;
  reason: "terminal_status" | "substantive_document" | "substantive_comment" | "no_substantive_artifact";
  artifactKey?: string | null;
};

const NON_FINAL_DOCUMENT_KEYS = new Set(["continuation-summary", "worker-handoff", "validation-contract", "mission-ledger"]);

export function shouldTreatIssueArtifactsAsSubstantive(
  input: MissionControlArtifactLivenessInput,
): MissionControlArtifactLivenessResult {
  if (input.status === "done" || input.status === "in_review") {
    return { substantive: true, reason: "terminal_status", artifactKey: null };
  }

  const substantiveDocument = input.documents.find((doc) => {
    const key = doc.key.trim().toLowerCase();
    const body = doc.body?.trim() ?? "";
    if (NON_FINAL_DOCUMENT_KEYS.has(key)) return false;
    if (/\b(final|blueprint|synthesis|report|spec|deliverable)\b/i.test(key)) return body.length >= 1000;
    return body.length >= 3000;
  });
  if (substantiveDocument) {
    return { substantive: true, reason: "substantive_document", artifactKey: substantiveDocument.key };
  }

  const substantiveComment = input.comments.find((comment) => {
    const body = comment.body.trim();
    return body.length >= 1000 && /\b(final|done|deliverable|attached|completed)\b/i.test(body);
  });
  if (substantiveComment) return { substantive: true, reason: "substantive_comment", artifactKey: null };

  return { substantive: false, reason: "no_substantive_artifact", artifactKey: null };
}
