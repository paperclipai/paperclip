import { z } from "zod";
import { envConfigSchema, pipelineAutomationRetryScopeSchema } from "@paperclipai/shared";

export const stageKindSchema = z.enum(["open", "working", "review", "done", "cancelled"]);
export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const stageConfigSchema = z.record(z.string(), z.unknown()).default({});
export const casePatchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  summary: z.string().max(8_000).nullable().optional(),
  fields: jsonObjectSchema.optional(),
  workspaceRef: jsonObjectSchema.nullable().optional(),
  parentCaseId: z.string().guid().nullable().optional(),
  expectedVersion: z.number().int().positive().optional(),
  leaseToken: z.string().guid().nullable().optional(),
});
export const ingestCaseSchema = z.object({
  caseKey: z.string().max(1_024).nullable().optional(),
  title: z.string().trim().min(1).max(500),
  summary: z.string().max(8_000).nullable().optional(),
  fields: jsonObjectSchema.optional(),
  stageKey: z.string().trim().min(1).max(120).optional(),
  parentCaseId: z.string().guid().nullable().optional(),
  requestKey: z.string().trim().min(1).max(512).optional(),
  workspaceRef: jsonObjectSchema.nullable().optional(),
  blockedByCaseIds: z.array(z.string().guid()).max(100).optional(),
  blockedByCaseKeys: z.array(z.string().max(1_024)).max(100).optional(),
});
export const createPipelineSchema = z.object({
  key: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(8_000).nullable().optional(),
  projectId: z.string().guid().nullable().optional(),
  enforceTransitions: z.boolean().optional(),
  stages: z.array(z.object({
    key: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(200),
    kind: stageKindSchema,
    position: z.number().int().optional(),
    config: stageConfigSchema.optional(),
  })).optional(),
});
export const updatePipelineSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(8_000).nullable().optional(),
  enforceTransitions: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export const createStageSchema = z.object({
  key: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  kind: stageKindSchema,
  position: z.number().int(),
  config: stageConfigSchema.optional(),
});
export const updateStageSchema = z.object({
  key: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  kind: stageKindSchema.optional(),
  position: z.number().int().optional(),
  config: stageConfigSchema.optional(),
});
export const updateStageAutomationEnvSchema = z.object({
  env: envConfigSchema.nullable(),
  baseRoutineRevisionId: z.string().guid().nullable().optional(),
});
export const replaceTransitionsSchema = z.object({
  transitions: z.array(z.object({
    fromStageKey: z.string().trim().min(1).max(120),
    toStageKey: z.string().trim().min(1).max(120),
    label: z.string().max(200).nullable().optional(),
  })).max(500),
  enforceTransitions: z.boolean().optional(),
});
export const batchIngestSchema = z.object({ items: z.array(ingestCaseSchema).max(200) });
export const breakdownCaseSchema = z.object({
  items: z.array(z.object({
    key: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    summary: z.string().max(8_000).nullable().optional(),
    fields: jsonObjectSchema.optional(),
  })).max(200),
});
export const claimCaseSchema = z.object({ leaseSeconds: z.number().int().positive().max(86_400).optional() });
export const releaseCaseSchema = z.object({
  leaseToken: z.string().guid().nullable().optional(),
  force: z.boolean().optional(),
});
export const transitionCaseSchema = z.object({
  toStageKey: z.string().trim().min(1).max(120),
  expectedVersion: z.number().int().positive(),
  leaseToken: z.string().guid().nullable().optional(),
  reason: z.string().max(4_000).nullable().optional(),
  force: z.boolean().optional(),
  acceptSuggestionId: z.string().guid().optional(),
});
export const suggestTransitionSchema = z.object({
  toStageKey: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1).max(8_000),
  confidence: z.number().min(0).max(1).optional(),
});
export const resolveSuggestionSchema = z.object({
  suggestionId: z.string().guid(),
  resolution: z.enum(["accept", "dismiss"]),
  expectedVersion: z.number().int().positive().optional(),
  reason: z.string().max(4_000).nullable().optional(),
  leaseToken: z.string().guid().nullable().optional(),
});
export const acknowledgeDriftSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
});
export const retryAutomationQuerySchema = z.object({
  scope: pipelineAutomationRetryScopeSchema.default("previous_stage"),
  targetStageId: z.string().guid().optional(),
});
export const reviewEditsSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  summary: z.string().max(8_000).nullable().optional(),
  fields: jsonObjectSchema.optional(),
  parentCaseId: z.string().guid().nullable().optional(),
});
export const reviewCaseSchema = z.object({
  decision: z.enum(["approve", "reject", "request_changes"]),
  reason: z.string().max(4_000).nullable().optional(),
  edits: reviewEditsSchema.optional(),
  expectedVersion: z.number().int().positive(),
  leaseToken: z.string().guid().nullable().optional(),
});
export const blockersSchema = z.object({ blockedByCaseIds: z.array(z.string().guid()).max(100) });
export const issueLinkRoleSchema = z.enum(["origin", "conversation", "work", "automation"]);
export const createIssueLinkSchema = z.object({
  issueId: z.string().guid(),
  role: issueLinkRoleSchema,
});
export const bulkReviewSchema = z.object({
  items: z.array(reviewCaseSchema.extend({ caseId: z.string().guid() })).max(100),
});
export const upsertPipelineDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(200_000),
  baseRevisionId: z.string().guid().nullable().optional(),
});
export const upsertPipelineCaseDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  format: z.string().trim().min(1).max(80).optional().default("markdown"),
  body: z.string().max(200_000),
  changeSummary: z.string().trim().max(1_000).nullable().optional(),
  baseRevisionId: z.string().guid().nullable().optional(),
});
