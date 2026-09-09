import { z } from "zod";
import { RECOVERY_ENGINEER_CLASSIFICATIONS } from "../types/recovery-engineer.js";

const guid = z.string().uuid();
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const boundedList = (maxItems: number, maxLength: number) =>
  z.array(boundedText(maxLength)).min(1).max(maxItems);

export const recoveryEngineerRepairProjectIdsSchema = z.object({
  framework: guid.optional(),
  native: guid.optional(),
}).strict();

export const recoveryEngineerConfigSchema = z.object({
  enabled: z.boolean(),
  agentId: guid,
  repairAgentId: guid,
  reviewerAgentId: guid,
  projectId: guid,
  repairProjectIds: recoveryEngineerRepairProjectIdsSchema.optional(),
  maxAttempts: z.literal(1),
  sweepIntervalSec: z.literal(300),
}).strict();

export const recoveryEngineerDiagnoseInputSchema = z.object({
  action: z.literal("diagnose"),
  classification: z.enum(RECOVERY_ENGINEER_CLASSIFICATIONS),
  hypothesis: boundedText(20_000),
  rootCause: boundedText(20_000).optional(),
  evidence: z.array(boundedText(20_000)).max(100),
  repairIssueId: guid.optional(),
}).strict();

export const recoveryEngineerProcedureInputSchema = z.object({
  action: z.literal("propose_procedure"),
  title: boundedText(500),
  preconditions: boundedList(100, 20_000),
  steps: boundedList(100, 20_000),
  successCheck: boundedText(20_000),
  stopConditions: boundedList(100, 20_000),
  rollback: boundedText(20_000),
  evidenceRunId: guid,
  repairCommit: boundedText(128),
}).strict();

export const recoveryEngineerRepairInputSchema = z.object({
  action: z.literal("request_repair"),
  target: z.enum(["framework", "native"]),
  title: boundedText(500),
  description: boundedText(20_000),
}).strict();

export const recoveryEngineerVerifyInputSchema = z.object({
  action: z.literal("verify"),
  reviewRunId: guid,
  repairCommit: boundedText(128),
  reproductionCommand: boundedText(20_000),
  reproductionResult: boundedText(20_000),
}).strict();

export const recoveryEngineerResumeInputSchema = z.object({
  action: z.literal("resume"),
  sourceIssueId: guid,
}).strict();

export const recoveryEngineerRecordInputSchema = z.discriminatedUnion("action", [
  recoveryEngineerDiagnoseInputSchema,
  recoveryEngineerProcedureInputSchema,
  recoveryEngineerRepairInputSchema,
  recoveryEngineerVerifyInputSchema,
  recoveryEngineerResumeInputSchema,
]);

export const recoveryEngineerProcedureReviewInputSchema = z.object({
  status: z.enum(["reviewed", "retired"]),
  reviewNote: boundedText(20_000),
}).strict();

export const recoveryEngineerActivationInputSchema = z.object({
  repairCommit: boundedText(128),
  activationEvidence: boundedText(20_000),
}).strict();

export type RecoveryEngineerConfigInput = z.infer<typeof recoveryEngineerConfigSchema>;
export type RecoveryEngineerRecordRequest = z.infer<typeof recoveryEngineerRecordInputSchema>;
export type RecoveryEngineerProcedureReviewRequest = z.infer<
  typeof recoveryEngineerProcedureReviewInputSchema
>;
export type RecoveryEngineerActivationRequest = z.infer<
  typeof recoveryEngineerActivationInputSchema
>;
