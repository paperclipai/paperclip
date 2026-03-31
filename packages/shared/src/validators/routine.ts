import { z } from "zod";
import {
  ISSUE_PRIORITIES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_SIGNING_MODES,
} from "../constants.js";

export const createRoutineSchema = z.object({
  projectId: z.string().uuid(),
  goalId: z.string().uuid().optional().nullable(),
  parentIssueId: z.string().uuid().optional().nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  assigneeAgentId: z.string().uuid(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  status: z.enum(ROUTINE_STATUSES).optional().default("active"),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES).optional().default("coalesce_if_active"),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES).optional().default("skip_missed"),
});

export type CreateRoutine = z.infer<typeof createRoutineSchema>;

export const updateRoutineSchema = createRoutineSchema.partial();
export type UpdateRoutine = z.infer<typeof updateRoutineSchema>;

const baseTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional().default(true),
});

export const createRoutineTriggerSchema = z.discriminatedUnion("kind", [
  baseTriggerSchema.extend({
    kind: z.literal("schedule"),
    cronExpression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).default("UTC"),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("webhook"),
    signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().default("bearer"),
    replayWindowSec: z.number().int().min(30).max(86_400).optional().default(300),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("api"),
  }),
]);

export type CreateRoutineTrigger = z.infer<typeof createRoutineTriggerSchema>;

export const updateRoutineTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().trim().min(1).optional().nullable(),
  timezone: z.string().trim().min(1).optional().nullable(),
  signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().nullable(),
  replayWindowSec: z.number().int().min(30).max(86_400).optional().nullable(),
});

export type UpdateRoutineTrigger = z.infer<typeof updateRoutineTriggerSchema>;

export const runRoutineSchema = z.object({
  triggerId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
  idempotencyKey: z.string().trim().max(255).optional().nullable(),
  source: z.enum(["manual", "api"]).optional().default("manual"),
});

export type RunRoutine = z.infer<typeof runRoutineSchema>;

export const rotateRoutineTriggerSecretSchema = z.object({});
export type RotateRoutineTriggerSecret = z.infer<typeof rotateRoutineTriggerSecretSchema>;
