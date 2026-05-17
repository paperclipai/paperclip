import { z } from "zod";
import {
  STANDUP_ACTION_STATUSES,
  STANDUP_OUTBOX_JOB_TYPES,
  STANDUP_POLICY_STATUSES,
} from "../constants.js";

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const localTimeSchema = z.string().regex(/^\d{2}:\d{2}$/, "Expected HH:MM");
const nonEmptyRecordSchema = z.record(z.unknown()).default({});
const serviceRunIdSchema = z.string().uuid();

export const standupResponseBodySchema = z.object({
  whatHappened: z.string().trim().min(1).max(4000),
  why: z.string().trim().min(1).max(4000),
  nextAction: z.string().trim().min(1).max(4000),
  owner: z.string().trim().min(1).max(200),
  dueTime: z.string().trim().min(1).max(200),
  proofTarget: z.string().trim().min(1).max(1000),
  blockerOrAuthorityGap: z.string().trim().min(1).max(4000),
  immediateActionTaken: z.string().trim().min(1).max(4000),
}).catchall(z.unknown());

export type StandupResponseBody = z.infer<typeof standupResponseBodySchema>;

export const upsertStandupPolicySchema = z.object({
  policyKey: z.string().trim().min(1).max(120),
  standupType: z.string().trim().min(1).max(80).default("daily"),
  title: z.string().trim().min(1).max(200),
  status: z.enum(STANDUP_POLICY_STATUSES).optional().default("active"),
  timezone: z.string().trim().min(1).default("UTC"),
  scheduleCron: z.string().trim().min(1),
  recoveryByLocalTime: localTimeSchema,
  responseDueLocalTime: localTimeSchema,
  escalationDueLocalTime: localTimeSchema,
  participantAgentIds: z.array(z.string().uuid()).min(1),
  responseSchema: nonEmptyRecordSchema,
  genericAnswerDenylist: z.array(z.string().trim().min(1)).default([]),
  nonGreenTriggerRule: nonEmptyRecordSchema,
  actionRouting: nonEmptyRecordSchema,
  disableSettings: nonEmptyRecordSchema,
  linkedRoutineId: z.string().uuid().optional().nullable(),
  serviceRunId: serviceRunIdSchema,
});

export type UpsertStandupPolicy = z.infer<typeof upsertStandupPolicySchema>;

export const manualStandupFireSchema = z.object({
  policyKey: z.string().trim().min(1).max(120),
  standupType: z.string().trim().min(1).max(80).default("daily"),
  localDate: localDateSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
  triggerConditionSnapshot: nonEmptyRecordSchema,
  assessmentSnapshot: nonEmptyRecordSchema,
  manualTriggerReceipt: z.record(z.unknown()).optional(),
  serviceRunId: serviceRunIdSchema,
});

export type ManualStandupFire = z.infer<typeof manualStandupFireSchema>;

export const submitStandupResponseSchema = z.object({
  sessionId: z.string().uuid(),
  participantId: z.string().uuid(),
  actorRunId: z.string().uuid(),
  response: standupResponseBodySchema,
});

export type SubmitStandupResponse = z.infer<typeof submitStandupResponseSchema>;

export const evaluateStandupSlaSchema = z.object({
  sessionId: z.string().uuid(),
  now: z.string().datetime().optional(),
  serviceRunId: serviceRunIdSchema,
});

export type EvaluateStandupSla = z.infer<typeof evaluateStandupSlaSchema>;

export const createStandupActionSchema = z.object({
  sessionId: z.string().uuid(),
  ownerAgentId: z.string().uuid(),
  sourceBlockerKey: z.string().trim().min(1).max(255),
  canonicalKey: z.string().trim().min(1).max(255),
  dueAt: z.string().datetime(),
  proofTarget: z.string().trim().min(1).max(1000),
  timingState: z.string().trim().min(1).max(120),
  status: z.enum(STANDUP_ACTION_STATUSES).optional().default("open"),
  actionJson: z.record(z.unknown()).optional().default({}),
  serviceRunId: serviceRunIdSchema,
});

export type CreateStandupAction = z.infer<typeof createStandupActionSchema>;

export const inspectStandupSchema = z.object({
  companyId: z.string().uuid().optional(),
  policyKey: z.string().trim().min(1).max(120).optional(),
  sessionId: z.string().uuid().optional(),
  localDate: localDateSchema.optional(),
  standupType: z.string().trim().min(1).max(80).optional(),
}).refine((value) => value.sessionId || (value.companyId && value.policyKey && value.localDate), {
  message: "Provide sessionId or companyId plus policyKey plus localDate",
});

export type InspectStandup = z.infer<typeof inspectStandupSchema>;

export const replayStandupOutboxJobSchema = z.object({
  jobId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).max(255),
  jobType: z.enum(STANDUP_OUTBOX_JOB_TYPES).optional(),
  serviceRunId: serviceRunIdSchema,
});

export type ReplayStandupOutboxJob = z.infer<typeof replayStandupOutboxJobSchema>;

export const processStandupOutboxSchema = z.object({
  companyId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  now: z.string().datetime().optional(),
  serviceRunId: serviceRunIdSchema,
});

export type ProcessStandupOutbox = z.infer<typeof processStandupOutboxSchema>;

export const disableStandupPolicySchema = z.object({
  policyKey: z.string().trim().min(1).max(120),
  standupType: z.string().trim().min(1).max(80).default("daily"),
  reason: z.string().trim().min(1).max(1000),
  drainMode: z.enum(["drain", "dead_letter", "leave_visible"]).default("drain"),
  serviceRunId: serviceRunIdSchema,
});

export type DisableStandupPolicy = z.infer<typeof disableStandupPolicySchema>;
