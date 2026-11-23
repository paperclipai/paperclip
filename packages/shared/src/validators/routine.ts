import { z } from "zod";
import {
  ISSUE_PRIORITIES,
  ROUTINE_ACTIVITY_GATE_POLICIES,
  ROUTINE_ACTIVITY_GATE_SCOPES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_EXTERNAL_SOURCES,
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_KINDS,
  ROUTINE_TRIGGER_SIGNING_MODES,
  ROUTINE_VARIABLE_TYPES,
} from "../constants.js";
import {
  ISSUE_EXECUTION_WORKSPACE_PREFERENCES,
  issueExecutionWorkspaceSettingsSchema,
} from "./issue.js";
import { envConfigSchema } from "./secret.js";
import { isValidRoutineDateString } from "../routine-variables.js";
import { objectWithoutDefaults } from "./partial.js";

const routineVariableValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const routineVariableSchema = z.object({
  name: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  label: z.string().trim().max(120).optional().nullable(),
  type: z.enum(ROUTINE_VARIABLE_TYPES).optional().default("text"),
  defaultValue: routineVariableValueSchema.optional().nullable(),
  required: z.boolean().optional().default(true),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional().default([]),
}).superRefine((value, ctx) => {
  if (value.type === "select" && value.options.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Select variables require at least one option",
    });
  }
  if (value.type !== "select" && value.options.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Only select variables can define options",
    });
  }
  if (value.type === "select" && value.defaultValue != null) {
    if (typeof value.defaultValue !== "string" || !value.options.includes(value.defaultValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "Select variable defaults must match one of the allowed options",
      });
    }
  }
  if (value.type === "date" && value.defaultValue != null) {
    if (typeof value.defaultValue !== "string" || !isValidRoutineDateString(value.defaultValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "Date variable defaults must be valid YYYY-MM-DD calendar dates",
      });
    }
  }
});

export const createRoutineSchema = z.object({
  projectId: z.string().guid().optional().nullable(),
  folderId: z.string().guid().optional().nullable(),
  goalId: z.string().guid().optional().nullable(),
  parentIssueId: z.string().guid().optional().nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  assigneeAgentId: z.string().guid().optional().nullable(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  status: z.enum(ROUTINE_STATUSES).optional().default("active"),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES).optional().default("coalesce_if_active"),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES).optional().default("skip_missed"),
  activityGatePolicy: z.enum(ROUTINE_ACTIVITY_GATE_POLICIES).optional(),
  activityGateScope: z.enum(ROUTINE_ACTIVITY_GATE_SCOPES).optional(),
  variables: z.array(routineVariableSchema).optional().default([]),
  env: envConfigSchema.optional().nullable(),
});

export type CreateRoutine = z.infer<typeof createRoutineSchema>;

export const updateRoutineSchema = objectWithoutDefaults(createRoutineSchema).partial().extend({
  baseRevisionId: z.string().guid().optional().nullable(),
  responsibleUserId: z.string().trim().min(1).optional(),
  /**
   * Replace the routine's schedule in the same change and revision: one
   * enabled schedule trigger at this time (other schedule triggers are turned
   * off), or null to turn every schedule off. Other triggers are left alone.
   * Without a timezone it keeps the current schedule's, else uses the
   * responsible person's own time zone.
   */
  schedule: z.object({
    cronExpression: z.string().trim().min(1).max(200),
    timezone: z.string().trim().min(1).max(100).optional(),
  }).strict().nullable().optional(),
});
export type UpdateRoutine = z.infer<typeof updateRoutineSchema>;

export const routineRevisionSnapshotRoutineV1Schema = z.object({
  id: z.string().guid(),
  companyId: z.string().guid(),
  projectId: z.string().guid().nullable(),
  folderId: z.string().guid().nullable().optional(),
  goalId: z.string().guid().nullable(),
  parentIssueId: z.string().guid().nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().nullable(),
  assigneeAgentId: z.string().guid().nullable(),
  priority: z.enum(ISSUE_PRIORITIES),
  status: z.enum(ROUTINE_STATUSES),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES),
  activityGatePolicy: z.enum(ROUTINE_ACTIVITY_GATE_POLICIES).default("always"),
  activityGateScope: z.enum(ROUTINE_ACTIVITY_GATE_SCOPES).default("company"),
  variables: z.array(routineVariableSchema),
  env: envConfigSchema.nullable().default(null),
  responsibleUserId: z.string().nullable().default(null),
}).strict();

export const routineRevisionSnapshotTriggerV1Schema = z.object({
  id: z.string().guid(),
  setupPending: z.boolean().optional(),
  kind: z.enum(ROUTINE_TRIGGER_KINDS),
  label: z.string().nullable(),
  enabled: z.boolean(),
  cronExpression: z.string().nullable(),
  timezone: z.string().nullable(),
  publicId: z.string().nullable(),
  signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).nullable(),
  replayWindowSec: z.number().int().min(30).max(86_400).nullable(),
}).strict();

export const routineRevisionSnapshotV1Schema = z.object({
  version: z.literal(1),
  routine: routineRevisionSnapshotRoutineV1Schema,
  triggers: z.array(routineRevisionSnapshotTriggerV1Schema),
}).strict();

export const routineRevisionSnapshotSchema = routineRevisionSnapshotV1Schema;
export type RoutineRevisionSnapshotV1 = z.infer<typeof routineRevisionSnapshotV1Schema>;
export type RoutineRevisionSnapshot = z.infer<typeof routineRevisionSnapshotSchema>;

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
    setupPending: z.boolean().optional(),
    signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().default("bearer"),
    replayWindowSec: z.number().int().min(30).max(86_400).optional().default(300),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("api"),
  }),
  // A standing check (experimental `enableResponsibilities`): never fires a run;
  // the routine's agent carries it out on each heartbeat wake-up.
  baseTriggerSchema.extend({
    kind: z.literal("heartbeat"),
  }),
]);

export type CreateRoutineTrigger = z.infer<typeof createRoutineTriggerSchema>;

export const updateRoutineTriggerSchema = z.object({
  setupPending: z.boolean().optional(),
  archived: z.boolean().optional(),
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().trim().min(1).optional().nullable(),
  timezone: z.string().trim().min(1).optional().nullable(),
  signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().nullable(),
  replayWindowSec: z.number().int().min(30).max(86_400).optional().nullable(),
});

export type UpdateRoutineTrigger = z.infer<typeof updateRoutineTriggerSchema>;

export const runRoutineSchema = z.object({
  triggerId: z.string().guid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  variables: z.record(z.string(), routineVariableValueSchema).optional().nullable(),
  projectId: z.string().guid().optional().nullable(),
  projectWorkspaceId: z.string().guid().optional().nullable(),
  assigneeAgentId: z.string().guid().optional().nullable(),
  idempotencyKey: z.string().trim().max(255).optional().nullable(),
  source: z.enum(["manual", "api"]).optional().default("manual"),
  executionWorkspaceId: z.string().guid().optional().nullable(),
  executionWorkspacePreference: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
});

export type RunRoutine = z.infer<typeof runRoutineSchema>;

export const rotateRoutineTriggerSecretSchema = z.object({});
export type RotateRoutineTriggerSecret = z.infer<typeof rotateRoutineTriggerSecretSchema>;

// ---------- External (observed) routines ----------
// Routine rows that mirror schedulers living outside Paperclip (systemd timers,
// Hermes crons, k8s CronJobs, Camel routes, Grok Bot routines). They are
// upserted from the Greybeard OS manifest and updated with observations; they
// carry no Paperclip triggers and never dispatch agent work here.

export const externalRoutineUpsertItemSchema = z.object({
  /** Stable external id (the GBOS manifest component id), kept in routines.origin_id. */
  id: z.string().trim().min(1).max(200),
  source: z.enum(ROUTINE_EXTERNAL_SOURCES),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8_000).optional().nullable(),
  /** Owning domain label from the manifest (e.g. "cos", "gbit"). Informational only. */
  owner: z.string().trim().max(120).optional().nullable(),
  /** Scheduler unit/job name (systemd unit, Hermes job, CronJob name...). */
  unit: z.string().trim().max(200).optional().nullable(),
  host: z.string().trim().max(200).optional().nullable(),
  /** Raw schedule expression as displayed by the external scheduler. */
  schedule: z.string().trim().max(200).optional().nullable(),
  /** Expected seconds between runs, when the manifest knows the cadence. */
  cadenceSec: z.number().int().min(0).max(10 * 366 * 24 * 60 * 60).optional().nullable(),
  /** Cost class from the manifest (none|llm|llm-jev|gpu|external-api). */
  cost: z.string().trim().max(60).optional().nullable(),
  revenue: z.string().trim().max(60).optional().nullable(),
  status: z.enum(ROUTINE_STATUSES).optional().default("active"),
}).strict();

export type ExternalRoutineUpsertItem = z.infer<typeof externalRoutineUpsertItemSchema>;

export const upsertExternalRoutinesSchema = z.object({
  items: z.array(externalRoutineUpsertItemSchema).min(1).max(500),
});
export type UpsertExternalRoutines = z.infer<typeof upsertExternalRoutinesSchema>;

export const createRoutineObservationSchema = z.object({
  status: z.enum(["success", "failure", "skipped"]),
  /** When the external scheduler fired. Defaults to now. */
  observedAt: z.coerce.date().optional().nullable(),
  /** When the observed run finished. Defaults to received time. */
  completedAt: z.coerce.date().optional().nullable(),
  durationMs: z.number().int().min(0).optional().nullable(),
  host: z.string().trim().max(200).optional().nullable(),
  unit: z.string().trim().max(200).optional().nullable(),
  cadenceSec: z.number().int().min(0).max(10 * 366 * 24 * 60 * 60).optional().nullable(),
  costUsd: z.number().min(0).max(1_000_000).optional().nullable(),
  failureReason: z.string().max(1_000).optional().nullable(),
  /** Stable id for the observation (e.g. gbos run id); replays return the first row. */
  idempotencyKey: z.string().trim().min(1).max(255).optional().nullable(),
}).strict();

export type CreateRoutineObservation = z.infer<typeof createRoutineObservationSchema>;
