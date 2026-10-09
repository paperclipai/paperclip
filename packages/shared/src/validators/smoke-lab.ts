import { z } from "zod";
import {
  SMOKE_RUN_STATUSES,
  SMOKE_RUN_STEP_PATHS,
  SMOKE_RUN_STEP_STATUSES,
  SMOKE_RUN_TRIGGERS,
} from "../types/smoke-lab.js";

export const smokeRunTriggerSchema = z.enum(SMOKE_RUN_TRIGGERS);
export const smokeRunStatusSchema = z.enum(SMOKE_RUN_STATUSES);
export const smokeRunStepPathSchema = z.enum(SMOKE_RUN_STEP_PATHS);
export const smokeRunStepStatusSchema = z.enum(SMOKE_RUN_STEP_STATUSES);

export const createSmokeRunSchema = z.object({
  trigger: smokeRunTriggerSchema.default("manual"),
  summary: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const updateSmokeRunSchema = z.object({
  status: smokeRunStatusSchema,
  summary: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const recordSmokeRunStepSchema = z.object({
  path: smokeRunStepPathSchema,
  scenarioStep: z.string().min(1).max(200),
  status: smokeRunStepStatusSchema,
  detail: z.string().max(4_000).nullable().optional(),
  screenshotArtifactRef: z.record(z.string(), z.unknown()).nullable().optional(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).nullable().optional(),
}).strict();

export type CreateSmokeRun = z.infer<typeof createSmokeRunSchema>;
export type UpdateSmokeRun = z.infer<typeof updateSmokeRunSchema>;
export type RecordSmokeRunStep = z.infer<typeof recordSmokeRunStepSchema>;
