import { z } from "zod";
import { DELIVERABLE_AUDIENCES, WORKFLOW_STATUSES } from "../constants.js";
import {
  workflowInvocationEnvelopeSchema,
  workflowInvocationJsonPayloadSchema,
  workflowInvocationMarkdownPayloadSchema,
  workflowInvocationTargetSelectorSchema,
  routineWorkflowInvocationRequestSchema,
} from "./workflow-invocation.js";

export const workflowRunnerTypeSchema = z.literal("google_adk");
export const workflowStatusSchema = z.enum(["active", "paused", "archived"]);
export const workflowScheduleStatusSchema = z.enum(WORKFLOW_STATUSES);
export const workflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_human",
  "succeeded",
  "failed",
  "cancelled",
]);
export const workflowPhaseStatusSchema = z.enum([
  "idle",
  "running",
  "awaiting_human",
  "succeeded",
  "failed",
  "cancelled",
]);
export const workflowHandoffKindSchema = z.enum(["approval", "response"]);
export const workflowHandoffStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "responded",
  "cancelled",
]);

export const workflowPromptTemplateSchema = z.object({
  label: z.string().trim().min(1).max(200),
  promptMarkdown: z.string()
    .min(1)
    .max(100_000)
    .refine((value) => value.trim().length > 0, {
      message: "Prompt template body cannot be blank.",
    }),
});
export type WorkflowPromptTemplate = z.infer<typeof workflowPromptTemplateSchema>;

export const workflowRunnerConfigSchema = z.object({
  agentPath: z.string().trim().min(1),
  command: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  model: z.string().trim().optional(),
  instructionsFilePath: z.string().trim().min(1).optional(),
  promptTemplate: z.string().optional(),
  promptTemplates: z.array(workflowPromptTemplateSchema).optional(),
  extraArgs: z.array(z.string()).optional(),
  timeoutSec: z.number().int().min(1).max(86_400).optional(),
  graceSec: z.number().int().min(1).max(600).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).passthrough();

export const workflowCapabilitySchema = z.string().trim().min(1).max(200);

export const workflowPipelinePhaseSchema = z.object({
  key: z.string().trim().min(1).max(255),
  label: z.string().trim().min(1).max(200),
  kind: z.enum(["phase", "agent", "loop", "tool", "validator"]),
  filePath: z.string().trim().min(1).nullable(),
  functionName: z.string().trim().min(1).nullable(),
  ordinal: z.number().int().min(0),
  parentKey: z.string().trim().min(1).max(255).nullable().optional(),
  depth: z.number().int().min(0).optional(),
  agentName: z.string().trim().min(1).max(255).nullable().optional(),
  description: z.string().trim().min(1).max(2_000).nullable().optional(),
});

export const workflowPipelineDefinitionSchema = z.object({
  entrypoint: z.string().trim().min(1),
  generatedAt: z.string().trim().min(1),
  phases: z.array(workflowPipelinePhaseSchema).default([]),
});

export const createWorkflowSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().nullable().optional(),
  status: workflowStatusSchema.optional().default("active"),
  workflowKey: z.string().trim().min(1).max(200).optional().nullable(),
  capabilities: z.array(workflowCapabilitySchema).optional().default([]),
  runnerType: workflowRunnerTypeSchema.optional().default("google_adk"),
  runnerConfig: workflowRunnerConfigSchema,
});

export type CreateWorkflow = z.infer<typeof createWorkflowSchema>;

export const updateWorkflowSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  status: workflowStatusSchema.optional(),
  workflowKey: z.string().trim().min(1).max(200).optional().nullable(),
  capabilities: z.array(workflowCapabilitySchema).optional(),
  runnerType: workflowRunnerTypeSchema.optional(),
  runnerConfig: workflowRunnerConfigSchema.partial().optional(),
});
export type UpdateWorkflow = z.infer<typeof updateWorkflowSchema>;

export {
  workflowInvocationEnvelopeSchema,
  workflowInvocationJsonPayloadSchema,
  workflowInvocationMarkdownPayloadSchema,
  workflowInvocationTargetSelectorSchema,
  routineWorkflowInvocationRequestSchema,
};

export const runWorkflowSchema = z.object({
  inputMarkdown: z.string().trim().min(1).max(200_000),
});
export type RunWorkflow = z.infer<typeof runWorkflowSchema>;

export const workflowCallbackAuthSchema = z.object({
  token: z.string().trim().min(1),
});

export const workflowPhaseEventSchema = z.object({
  phaseKey: z.string().trim().min(1).max(255),
  label: z.string().trim().min(1).max(200).optional(),
  status: workflowPhaseStatusSchema,
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type WorkflowPhaseEvent = z.infer<typeof workflowPhaseEventSchema>;

export const createWorkflowHandoffSchema = z.object({
  phaseKey: z.string().trim().min(1).max(255),
  kind: workflowHandoffKindSchema,
  promptMarkdown: z.string().trim().min(1).max(100_000),
});
export type CreateWorkflowHandoff = z.infer<typeof createWorkflowHandoffSchema>;

export const resolveWorkflowHandoffSchema = z.object({
  responseMarkdown: z.string().trim().max(100_000).nullable().optional(),
});
export type ResolveWorkflowHandoff = z.infer<typeof resolveWorkflowHandoffSchema>;

export const createWorkflowDeliverableSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(1000).nullable().optional(),
  audience: z.enum(DELIVERABLE_AUDIENCES).optional().default("human"),
  contentType: z.string().trim().min(1).max(255),
  contentPath: z.string().trim().min(1).nullable().optional(),
  contentBody: z.string().nullable().optional(),
  byteSize: z.number().int().min(0),
  originalFilename: z.string().trim().max(255).nullable().optional(),
});
export type CreateWorkflowDeliverable = z.infer<typeof createWorkflowDeliverableSchema>;

export const createWorkflowScheduleSchema = z.object({
  title: z.string().trim().min(1).max(200),
  cronExpression: z.string().trim().min(1).max(200),
  templateMarkdown: z.string().min(1).max(100_000).refine((value) => value.trim().length > 0, {
    message: "Schedule template body cannot be blank.",
  }),
  status: workflowScheduleStatusSchema.optional().default("active"),
});
export type CreateWorkflowSchedule = z.infer<typeof createWorkflowScheduleSchema>;

export const updateWorkflowScheduleSchema = createWorkflowScheduleSchema.partial();
export type UpdateWorkflowSchedule = z.infer<typeof updateWorkflowScheduleSchema>;
