import { z } from "zod";
import {
  ISSUE_PRIORITIES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
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
  projectId: z.string().uuid().optional().nullable(),
  folderId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentIssueId: z.string().uuid().optional().nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  status: z.enum(ROUTINE_STATUSES).optional().default("active"),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES).optional().default("coalesce_if_active"),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES).optional().default("skip_missed"),
  variables: z.array(routineVariableSchema).optional().default([]),
  env: envConfigSchema.optional().nullable(),
});

export type CreateRoutine = z.infer<typeof createRoutineSchema>;

export const updateRoutineSchema = createRoutineSchema.partial().extend({
  baseRevisionId: z.string().uuid().optional().nullable(),
});
export type UpdateRoutine = z.infer<typeof updateRoutineSchema>;

export const routineRevisionSnapshotRoutineV1Schema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  folderId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable(),
  parentIssueId: z.string().uuid().nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().nullable(),
  assigneeAgentId: z.string().uuid().nullable(),
  priority: z.enum(ISSUE_PRIORITIES),
  status: z.enum(ROUTINE_STATUSES),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES),
  variables: z.array(routineVariableSchema),
  env: envConfigSchema.nullable().default(null),
  responsibleUserId: z.string().nullable().default(null),
}).strict();

export const routineRevisionSnapshotTriggerV1Schema = z.object({
  id: z.string().uuid(),
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

const ROUTINE_EXCEPTION_SENSITIVE_VALUE_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|authorization:\s*bearer\s+\S+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,})/i;

export const routineExceptionEvidenceSchema = z.object({
  key: z.string().trim().min(1).max(120),
  source: z.string().trim().min(1).max(240),
  observedAt: z.string().datetime(),
  valueDigest: z.string().regex(/^[a-f0-9]{64}$/),
  safeValue: z.string().max(4_000).optional(),
}).strict().superRefine((evidence, ctx) => {
  if (evidence.safeValue && ROUTINE_EXCEPTION_SENSITIVE_VALUE_PATTERN.test(evidence.safeValue)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["safeValue"],
      message: "Evaluator evidence contains sensitive material",
    });
  }
});

export const routineExceptionClosureCandidateSchema = z.object({
  artifactType: z.enum(["issue", "approval"]),
  artifactId: z.string().uuid(),
  recommendation: z.enum(["close", "supersede"]),
}).strict();

export const routineExceptionEvaluationResultV1Schema = z.object({
  schemaVersion: z.literal(1),
  outcome: z.enum(["PASS", "EXCEPTION", "UNVERIFIABLE"]),
  severity: z.enum(["high", "critical"]).nullable(),
  rootCauseCode: z.string().trim().min(1).max(120).regex(/^[A-Z0-9_:-]+$/).nullable(),
  affectedResource: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(2_000),
  evidence: z.array(routineExceptionEvidenceSchema).max(100),
  recoveredFingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100),
  closureCandidates: z.array(routineExceptionClosureCandidateSchema).max(100),
  retryClass: z.enum(["NONE", "TRANSIENT_READ"]),
}).strict().superRefine((result, ctx) => {
  if (ROUTINE_EXCEPTION_SENSITIVE_VALUE_PATTERN.test(result.summary)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary"],
      message: "Evaluator summary contains sensitive material",
    });
  }
  if (result.outcome !== "UNVERIFIABLE" && result.evidence.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "PASS and EXCEPTION require evidence",
    });
  }
  if (result.outcome === "PASS") {
    if (result.severity !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severity"], message: "PASS severity must be null" });
    }
    if (result.rootCauseCode !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rootCauseCode"], message: "PASS rootCauseCode must be null" });
    }
  } else {
    if (result.severity === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severity"], message: "Exception severity is required" });
    }
    if (result.rootCauseCode === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rootCauseCode"], message: "Exception rootCauseCode is required" });
    }
  }
});

export const routineExceptionEvaluatorBindingSchema = z.object({
  enabled: z.boolean().default(false),
  companyId: z.string().uuid(),
  routineId: z.string().uuid(),
  routineRevisionId: z.string().uuid(),
  evaluatorId: z.enum(["pol.runtime-source-of-truth.v1", "pol.approval-release.v1"]),
  evaluatorContractVersion: z.string().trim().min(1).max(120),
  inputSchemaVersion: z.literal(1),
  typedConfig: z.record(z.string(), z.unknown()).default({}),
  allowedCapabilityIds: z.array(z.string().trim().min(1).max(240)).max(32),
}).strict();

export const routineExceptionEvaluationInputV1Schema = z.object({
  schemaVersion: z.literal(1),
  run: z.object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    routineId: z.string().uuid(),
    routineRevisionId: z.string().uuid(),
    triggerId: z.string().uuid().nullable(),
    source: z.enum(["schedule", "manual", "api", "webhook"]),
    triggeredAt: z.string().datetime(),
    idempotencyKey: z.string().max(500).nullable(),
  }).strict(),
  binding: routineExceptionEvaluatorBindingSchema,
  triggerPayload: z.record(z.string(), z.unknown()).nullable(),
  openExceptions: z.array(z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    rootCauseCode: z.string().trim().min(1).max(120),
    affectedResource: z.string().trim().min(1).max(500),
    evaluatorContractVersion: z.string().trim().min(1).max(120),
  }).strict()).max(100),
}).strict();

export type RoutineExceptionEvaluatorBinding = z.infer<typeof routineExceptionEvaluatorBindingSchema>;
export type RoutineExceptionEvaluationInputV1 = z.infer<typeof routineExceptionEvaluationInputV1Schema>;
export type RoutineExceptionEvaluationResultV1 = z.infer<typeof routineExceptionEvaluationResultV1Schema>;

export const runRoutineSchema = z.object({
  triggerId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  variables: z.record(z.string(), routineVariableValueSchema).optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  projectWorkspaceId: z.string().uuid().optional().nullable(),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  idempotencyKey: z.string().trim().max(255).optional().nullable(),
  source: z.enum(["manual", "api"]).optional().default("manual"),
  executionWorkspaceId: z.string().uuid().optional().nullable(),
  executionWorkspacePreference: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
}).strict();

export type RunRoutine = z.infer<typeof runRoutineSchema>;

export const rotateRoutineTriggerSecretSchema = z.object({});
export type RotateRoutineTriggerSecret = z.infer<typeof rotateRoutineTriggerSecretSchema>;
