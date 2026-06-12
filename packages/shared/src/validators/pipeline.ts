import { z } from "zod";

const routineVariableLikeNameSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/);

export const pipelineStageKindSchema = z.enum(["working", "review", "done", "cancelled"]);
export const legacyPipelineStageKindSchema = z.enum(["open", "working", "review", "done", "cancelled"]);

export const pipelineStageApproverSchema = z.object({
  kind: z.enum(["any_human", "user", "agent"]).optional().default("any_human"),
  id: z.string().trim().min(1).max(200).optional(),
}).superRefine((value, ctx) => {
  if (value.kind !== "any_human" && (typeof value.id !== "string" || value.id.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["id"],
      message: "Specific stage approvers require an id",
    });
  }
});

export const pipelineStageOnEnterSchema = z.object({
  type: z.literal("run_routine"),
  routineId: z.string().uuid(),
  id: z.string().trim().min(1).max(200).optional(),
}).passthrough();

export const pipelineStageVariableSchema = z.object({
  key: routineVariableLikeNameSchema,
  label: z.string().trim().max(120),
  type: z.enum(["select", "text", "multiline"]).default("text"),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional().default([]),
  required: z.boolean().optional().default(false),
  showInAddForm: z.boolean().optional().default(false),
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
});

export const pipelineStageConfigSchema = z.object({
  variables: z.array(pipelineStageVariableSchema).default([]),
  disabled: z.boolean().optional(),
  disabledReason: z.string().trim().max(1_000).nullable().optional(),
  requireApproval: z.boolean().optional(),
  approver: pipelineStageApproverSchema.optional(),
  /** Legacy input only; the server migrates it to requireApproval/approver. */
  reviewerKind: z.enum(["human", "any"]).optional(),
  whatHappensHere: z.string().trim().max(10_000).optional(),
  onEnter: pipelineStageOnEnterSchema.optional(),
  approveToStageKey: z.string().trim().min(1).max(120).optional(),
  rejectToStageKey: z.string().trim().min(1).max(120).optional(),
  requestChangesToStageKey: z.string().trim().min(1).max(120).optional(),
  requireRejectReason: z.boolean().optional(),
  requireChildrenTerminal: z.boolean().optional(),
  requireNoUnresolvedDrift: z.boolean().optional(),
}).passthrough().superRefine((value, ctx) => {
  const keys = new Set<string>();
  value.variables.forEach((variable, index) => {
    if (keys.has(variable.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variables", index, "key"],
        message: "Pipeline stage variable keys must be unique",
      });
    }
    keys.add(variable.key);
  });
});

export type PipelineStageKind = z.infer<typeof pipelineStageKindSchema>;
export type PipelineStageApprover = z.infer<typeof pipelineStageApproverSchema>;
export type PipelineStageOnEnter = z.infer<typeof pipelineStageOnEnterSchema>;
export type PipelineStageVariable = z.infer<typeof pipelineStageVariableSchema>;
export type PipelineStageConfig = z.infer<typeof pipelineStageConfigSchema>;
