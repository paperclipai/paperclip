import { z } from "zod";

/**
 * D1-D5 contract seam only. Later slices may map this value to Paperclip/Hermes
 * persistence and orchestration; this module intentionally performs neither.
 */
export const AUTONOMOUS_STATE_CONTRACT_VERSION = 1 as const;
export const MAX_AUTONOMOUS_ATTEMPTS = 3 as const;

export const AUTONOMOUS_STATES = [
  "PENDING",
  "PLANNING",
  "RUNNING",
  "VERIFYING",
  "PASS",
  "FAILED",
  "RETRYING",
  "REPLANNING",
  "BLOCKED",
] as const;
export type AutonomousState = (typeof AUTONOMOUS_STATES)[number];
export const autonomousStateSchema = z.enum(AUTONOMOUS_STATES);

export const AUTONOMOUS_RISKS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type AutonomousRisk = (typeof AUTONOMOUS_RISKS)[number];
export const autonomousRiskSchema = z.enum(AUTONOMOUS_RISKS);

export const AUTONOMOUS_GATE_DECISIONS = ["PASS", "FAIL", "SKIP"] as const;
export type AutonomousGateDecision = (typeof AUTONOMOUS_GATE_DECISIONS)[number];
export const autonomousGateDecisionSchema = z.enum(AUTONOMOUS_GATE_DECISIONS);

const autonomousIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const autonomousTimestampSchema = z.string().datetime({ offset: true });
const autonomousActionIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const autonomousDependencySchema = z
  .object({
    dependencyId: autonomousIdSchema,
    state: z.enum(["PENDING", "RUNNING", "PASS", "FAILED", "BLOCKED"]),
  })
  .strict();
export type AutonomousDependency = z.infer<typeof autonomousDependencySchema>;

export const autonomousWorkerSchema = z
  .object({
    workerId: autonomousIdSchema,
    role: autonomousIdSchema,
    state: z.enum(["PENDING", "RUNNING", "PASS", "FAILED", "BLOCKED"]),
  })
  .strict();
export type AutonomousWorker = z.infer<typeof autonomousWorkerSchema>;

export const autonomousGateSummarySchema = z
  .object({
    gateId: autonomousIdSchema,
    decision: autonomousGateDecisionSchema,
  })
  .strict();
export type AutonomousGateSummary = z.infer<typeof autonomousGateSummarySchema>;

export const autonomousStateEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(AUTONOMOUS_STATE_CONTRACT_VERSION),
    executionId: autonomousIdSchema,
    taskId: autonomousIdSchema,
    parentExecutionId: autonomousIdSchema.nullable(),
    risk: autonomousRiskSchema,
    state: autonomousStateSchema,
    dependencies: z.array(autonomousDependencySchema).max(100),
    workers: z.array(autonomousWorkerSchema).max(100),
    gates: z.array(autonomousGateSummarySchema).max(100),
    attempt: z.number().int().min(1).max(MAX_AUTONOMOUS_ATTEMPTS),
    createdAt: autonomousTimestampSchema,
    updatedAt: autonomousTimestampSchema,
  })
  .strict()
  .refine((value) => Date.parse(value.updatedAt) >= Date.parse(value.createdAt), {
    message: "updatedAt must not be earlier than createdAt",
    path: ["updatedAt"],
  });
export type AutonomousStateEnvelope = z.infer<typeof autonomousStateEnvelopeSchema>;

/** Explicit transition matrix; absent edges are rejected. */
export const AUTONOMOUS_ALLOWED_TRANSITIONS: Readonly<
  Record<AutonomousState, readonly AutonomousState[]>
> = {
  PENDING: ["PLANNING"],
  PLANNING: ["RUNNING", "BLOCKED"],
  RUNNING: ["VERIFYING", "FAILED"],
  VERIFYING: ["PASS", "FAILED"],
  PASS: [],
  FAILED: ["RETRYING", "REPLANNING", "BLOCKED"],
  RETRYING: ["RUNNING", "FAILED"],
  REPLANNING: ["PLANNING", "BLOCKED"],
  BLOCKED: [],
};

export class InvalidAutonomousStateTransitionError extends Error {
  readonly code = "INVALID_AUTONOMOUS_STATE_TRANSITION" as const;
  readonly from: AutonomousState;
  readonly to: AutonomousState;

  constructor(from: AutonomousState, to: AutonomousState) {
    super(`Invalid autonomous state transition: ${from} -> ${to}`);
    this.name = "InvalidAutonomousStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionAutonomousState(
  from: AutonomousState,
  to: AutonomousState,
): boolean {
  return AUTONOMOUS_ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionAutonomousState(
  envelope: AutonomousStateEnvelope,
  to: AutonomousState,
  updatedAt: string,
): AutonomousStateEnvelope {
  if (!canTransitionAutonomousState(envelope.state, to)) {
    throw new InvalidAutonomousStateTransitionError(envelope.state, to);
  }
  autonomousTimestampSchema.parse(updatedAt);
  if (Date.parse(updatedAt) < Date.parse(envelope.updatedAt)) {
    throw new RangeError("updatedAt must not be earlier than the current updatedAt");
  }
  return { ...envelope, state: to, updatedAt };
}

export const autonomousGateEvidenceSchema = z
  .object({
    gateId: autonomousIdSchema,
    command: z.string().trim().min(1).max(2000),
    expected: z.string().max(4000),
    observed: z.string().max(4000),
    exitCode: z.number().int().min(0).max(255).nullable(),
    status: autonomousGateDecisionSchema,
    timestamp: autonomousTimestampSchema,
    evidenceRef: z.string().trim().min(1).max(2048),
  })
  .strict();
export type AutonomousGateEvidence = z.infer<typeof autonomousGateEvidenceSchema>;

export function evaluateAutonomousGate(
  evidence: AutonomousGateEvidence,
): AutonomousGateDecision {
  if (evidence.status === "SKIP") return "SKIP";
  return evidence.status === "PASS" && evidence.exitCode === 0 && evidence.observed === evidence.expected
    ? "PASS"
    : "FAIL";
}

export const AUTONOMOUS_FAILURE_DISPOSITIONS = ["RETRYING", "REPLANNING", "BLOCKED"] as const;
export type AutonomousFailureDisposition = (typeof AUTONOMOUS_FAILURE_DISPOSITIONS)[number];

export function nextFailureDisposition(
  attempt: number,
  canReplan: boolean,
): AutonomousFailureDisposition {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_AUTONOMOUS_ATTEMPTS) {
    throw new RangeError("Attempt must be between 1 and 3");
  }
  if (attempt < MAX_AUTONOMOUS_ATTEMPTS) return "RETRYING";
  return canReplan ? "REPLANNING" : "BLOCKED";
}

export const autonomousActionSchema = z
  .object({
    actionId: autonomousActionIdSchema,
    kind: z.enum(["RETRY", "REPLAN", "BLOCK"]),
    executionId: autonomousIdSchema,
    taskId: autonomousIdSchema,
    attempt: z.number().int().min(1).max(MAX_AUTONOMOUS_ATTEMPTS),
    nextState: z.enum(["RETRYING", "REPLANNING", "BLOCKED"]),
  })
  .strict();
export type AutonomousAction = z.infer<typeof autonomousActionSchema>;

export function createAutonomousFailureAction(
  envelope: AutonomousStateEnvelope,
  canReplan: boolean,
): AutonomousAction {
  if (envelope.state !== "FAILED") {
    throw new Error("Failure actions require FAILED state");
  }
  const nextState = nextFailureDisposition(envelope.attempt, canReplan);
  const kind = nextState === "RETRYING" ? "RETRY" : nextState === "REPLANNING" ? "REPLAN" : "BLOCK";
  return autonomousActionSchema.parse({
    actionId: `autonomous-action/${envelope.executionId}/${envelope.taskId}/${envelope.attempt}/${nextState}`,
    kind,
    executionId: envelope.executionId,
    taskId: envelope.taskId,
    attempt: envelope.attempt,
    nextState,
  });
}

/** D2-D5 mapping seam; implementations belong outside this pure contract module. */
export interface AutonomousStateMappingSeam<TSource> {
  fromSource(source: TSource): AutonomousStateEnvelope;
  toSource(envelope: AutonomousStateEnvelope): TSource;
}
