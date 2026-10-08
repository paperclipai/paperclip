import { z } from "zod";
import {
  MAX_AUTONOMOUS_ATTEMPTS,
  nextFailureDisposition,
} from "./autonomous-state-contract.js";

const autonomousRetryIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const autonomousRetryActionIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const AUTONOMOUS_FAILURE_KINDS = [
  "TRANSIENT",
  "PERMANENT",
  "DEPENDENCY",
  "GATE",
] as const;
export type AutonomousFailureKind = (typeof AUTONOMOUS_FAILURE_KINDS)[number];
export const autonomousFailureKindSchema = z.enum(AUTONOMOUS_FAILURE_KINDS);

export const AUTONOMOUS_RETRY_REASON_CODES = [
  "retry_scheduled",
  "retry_budget_exhausted",
  "permanent_failure",
  "dependency_blocked",
  "gate_blocked",
] as const;
export type AutonomousRetryReasonCode = (typeof AUTONOMOUS_RETRY_REASON_CODES)[number];
export const autonomousRetryReasonCodeSchema = z.enum(AUTONOMOUS_RETRY_REASON_CODES);

export const autonomousRetryInputSchema = z
  .object({
    executionId: autonomousRetryIdSchema,
    taskId: autonomousRetryIdSchema,
    attempt: z.number().int().min(1).max(MAX_AUTONOMOUS_ATTEMPTS),
    failureKind: autonomousFailureKindSchema,
    canReplan: z.boolean(),
    priorActionIds: z.array(autonomousRetryActionIdSchema).max(100),
  })
  .strict();
export type AutonomousRetryInput = z.infer<typeof autonomousRetryInputSchema>;

export const autonomousRetryDecisionSchema = z
  .object({
    actionId: autonomousRetryActionIdSchema,
    executionId: autonomousRetryIdSchema,
    taskId: autonomousRetryIdSchema,
    attempt: z.number().int().min(1).max(MAX_AUTONOMOUS_ATTEMPTS),
    failureKind: autonomousFailureKindSchema,
    disposition: z.enum(["RETRYING", "REPLANNING", "BLOCKED"]),
    retryAfterMs: z.number().int().min(0).nullable(),
    reasonCode: autonomousRetryReasonCodeSchema,
    blockedBy: z.enum(["DEPENDENCY", "GATE"]).nullable(),
  })
  .strict();
export type AutonomousRetryDecision = z.infer<typeof autonomousRetryDecisionSchema>;

export class DuplicateAutonomousReplanError extends Error {
  readonly code = "DUPLICATE_AUTONOMOUS_REPLAN" as const;
  readonly actionId: string;

  constructor(actionId: string) {
    super(`Autonomous replan action has already been issued: ${actionId}`);
    this.name = "DuplicateAutonomousReplanError";
    this.actionId = actionId;
  }
}

function blockedDecision(
  input: AutonomousRetryInput,
  reasonCode: AutonomousRetryReasonCode,
  blockedBy: "DEPENDENCY" | "GATE" | null,
): AutonomousRetryDecision {
  return autonomousRetryDecisionSchema.parse({
    actionId: `autonomous-action/${input.executionId}/${input.taskId}/${input.attempt}/BLOCKED`,
    executionId: input.executionId,
    taskId: input.taskId,
    attempt: input.attempt,
    failureKind: input.failureKind,
    disposition: "BLOCKED",
    retryAfterMs: null,
    reasonCode,
    blockedBy,
  });
}

/**
 * Pure D6 mapping of a failed autonomous attempt to a bounded continuation.
 * Transient failures get deterministic exponential backoff for attempts 1-2;
 * dependency, gate, and permanent failures fail closed without a retry.
 */
export function decideAutonomousRetry(input: AutonomousRetryInput): AutonomousRetryDecision {
  const parsed = autonomousRetryInputSchema.parse(input);

  if (parsed.failureKind === "PERMANENT") {
    return blockedDecision(parsed, "permanent_failure", null);
  }
  if (parsed.failureKind === "DEPENDENCY") {
    return blockedDecision(parsed, "dependency_blocked", "DEPENDENCY");
  }
  if (parsed.failureKind === "GATE") {
    return blockedDecision(parsed, "gate_blocked", "GATE");
  }

  const disposition = nextFailureDisposition(parsed.attempt, parsed.canReplan);
  if (disposition === "RETRYING") {
    return autonomousRetryDecisionSchema.parse({
      actionId: `autonomous-action/${parsed.executionId}/${parsed.taskId}/${parsed.attempt}/RETRYING`,
      executionId: parsed.executionId,
      taskId: parsed.taskId,
      attempt: parsed.attempt,
      failureKind: parsed.failureKind,
      disposition,
      retryAfterMs: 1_000 * 2 ** (parsed.attempt - 1),
      reasonCode: "retry_scheduled",
      blockedBy: null,
    });
  }

  const actionId =
    disposition === "REPLANNING"
      ? `autonomous-replan/${parsed.executionId}/${parsed.taskId}/${parsed.attempt}`
      : `autonomous-action/${parsed.executionId}/${parsed.taskId}/${parsed.attempt}/BLOCKED`;
  if (disposition === "REPLANNING" && parsed.priorActionIds.includes(actionId)) {
    throw new DuplicateAutonomousReplanError(actionId);
  }
  return autonomousRetryDecisionSchema.parse({
    actionId,
    executionId: parsed.executionId,
    taskId: parsed.taskId,
    attempt: parsed.attempt,
    failureKind: parsed.failureKind,
    disposition,
    retryAfterMs: null,
    reasonCode: "retry_budget_exhausted",
    blockedBy: null,
  });
}
