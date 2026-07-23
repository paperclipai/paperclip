import { z } from "zod";
import { ISSUE_STATUSES } from "../constants.js";

export const decisionEffectStalenessSchema = z.enum(["strict", "lenient"]);
export const decisionOptionStyleSchema = z.enum(["default", "primary", "destructive"]);

const decisionEffectBaseShape = {
  targetIssueId: z.string().uuid(),
  staleness: decisionEffectStalenessSchema,
};

export const commentOnIssueDecisionEffectSchema = z.object({
  type: z.literal("comment_on_issue"),
  ...decisionEffectBaseShape,
  bodyMarkdown: z.string().trim().min(1).max(20_000),
});

export const createIssueDecisionEffectSchema = z.object({
  type: z.literal("create_issue"),
  ...decisionEffectBaseShape,
  draft: z.object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
    assigneeAgentId: z.string().uuid().nullable().optional(),
    assigneeUserId: z.string().trim().min(1).nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    goalId: z.string().uuid().nullable().optional(),
    blockedByIssueIds: z.array(z.string().uuid()).max(100).optional(),
  }),
});

export const updateIssueStatusDecisionEffectSchema = z.object({
  type: z.literal("update_issue_status"),
  ...decisionEffectBaseShape,
  status: z.enum(ISSUE_STATUSES),
  comment: z.string().trim().min(1).max(20_000).nullable().optional(),
});

export const assignIssueDecisionEffectSchema = z.object({
  type: z.literal("assign_issue"),
  ...decisionEffectBaseShape,
  assigneeAgentId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().trim().min(1).nullable().optional(),
  comment: z.string().trim().min(1).max(20_000).nullable().optional(),
});

export const cancelIssueTreeDecisionEffectSchema = z.object({
  type: z.literal("cancel_issue_tree"),
  targetIssueId: z.string().uuid(),
  staleness: z.literal("strict"),
  reasonComment: z.string().trim().min(1).max(20_000),
});

export const resolveBlockerDecisionEffectSchema = z.object({
  type: z.literal("resolve_blocker"),
  ...decisionEffectBaseShape,
  removeBlockedByIssueIds: z.array(z.string().uuid()).min(1).max(100),
});

export const decisionEffectSchema = z.discriminatedUnion("type", [
  commentOnIssueDecisionEffectSchema,
  createIssueDecisionEffectSchema,
  updateIssueStatusDecisionEffectSchema,
  assignIssueDecisionEffectSchema,
  cancelIssueTreeDecisionEffectSchema,
  resolveBlockerDecisionEffectSchema,
]).superRefine((effect, ctx) => {
  if (effect.type === "create_issue" && effect.draft.assigneeAgentId && effect.draft.assigneeUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only one assignee may be set",
      path: ["draft", "assigneeUserId"],
    });
  }

  if (effect.type === "assign_issue") {
    const assigneeCount = Number(Boolean(effect.assigneeAgentId)) + Number(Boolean(effect.assigneeUserId));
    if (assigneeCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one assignee must be set",
        path: ["assigneeAgentId"],
      });
    }
  }
});

export const decisionInputSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  placeholder: z.string().max(500).nullable().optional(),
  required: z.boolean().optional(),
  maxLength: z.number().int().positive().max(20_000).optional(),
});

export const decisionOptionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  description: z.string().max(2_000).nullable().optional(),
  style: decisionOptionStyleSchema.optional(),
  effects: z.array(decisionEffectSchema).max(10),
}).superRefine((option, ctx) => {
  if (option.effects.some((effect) => effect.type === "cancel_issue_tree") && option.style !== "destructive") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Options that cancel an issue tree must use destructive style",
      path: ["style"],
    });
  }
});

export const decisionOptionsSchema = z.array(decisionOptionSchema).min(1).max(8).superRefine((options, ctx) => {
  const seenIds = new Set<string>();
  for (const [index, option] of options.entries()) {
    if (seenIds.has(option.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Decision option ids must be unique",
        path: [index, "id"],
      });
    }
    seenIds.add(option.id);
  }
});

export const decisionInputsSchema = z.array(decisionInputSchema).max(4).superRefine((inputs, ctx) => {
  const seenIds = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    if (seenIds.has(input.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Decision input ids must be unique",
        path: [index, "id"],
      });
    }
    seenIds.add(input.id);
  }
});

export const decisionSpecSchema = z.object({
  options: decisionOptionsSchema,
  inputs: decisionInputsSchema.nullable().optional(),
});

export type DecisionEffectInput = z.input<typeof decisionEffectSchema>;
export type DecisionOptionInput = z.input<typeof decisionOptionSchema>;
export type DecisionInputInput = z.input<typeof decisionInputSchema>;
export type DecisionSpecInput = z.input<typeof decisionSpecSchema>;
