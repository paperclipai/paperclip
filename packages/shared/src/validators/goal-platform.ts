import { z } from "zod";
import { ROADMAP_BLOCK_STATUSES } from "../constants.js";

export const createGoalTargetSchema = z.object({
  parentId: z.string().uuid().optional().nullable(),
  text: z.string().min(1).max(2_000),
  checked: z.boolean().optional().default(false),
  sortOrder: z.number().int().optional(),
});
export type CreateGoalTarget = z.infer<typeof createGoalTargetSchema>;

export const updateGoalTargetSchema = z.object({
  parentId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional(),
  text: z.string().min(1).max(2_000).optional(),
  checked: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export type UpdateGoalTarget = z.infer<typeof updateGoalTargetSchema>;

export const createGoalRelationSchema = z.object({
  type: z.literal("serves"),
  fromGoalId: z.string().uuid(),
  toGoalId: z.string().uuid().optional().nullable(),
  toTargetId: z.string().uuid().optional().nullable(),
}).superRefine((value, ctx) => {
  if (!value.toGoalId === !value.toTargetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of toGoalId or toTargetId must be set",
      path: ["toGoalId"],
    });
  }
});
export type CreateGoalRelation = z.infer<typeof createGoalRelationSchema>;

export const createRoadmapBlockSchema = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().max(2_000).optional().nullable(),
  status: z.enum(ROADMAP_BLOCK_STATUSES).optional().default("planned"),
  x: z.number().int(),
  y: z.number().int(),
});
export type CreateRoadmapBlock = z.infer<typeof createRoadmapBlockSchema>;

export const createRoadmapBlockLinkSchema = z.object({
  blockId: z.string().uuid(),
  goalId: z.string().uuid(),
});
export type CreateRoadmapBlockLink = z.infer<typeof createRoadmapBlockLinkSchema>;

export const updateRoadmapBlockSchema = createRoadmapBlockSchema.partial();
export type UpdateRoadmapBlock = z.infer<typeof updateRoadmapBlockSchema>;

export const createRoadmapBlockEdgeSchema = z.object({
  fromBlockId: z.string().uuid(),
  toBlockId: z.string().uuid(),
}).superRefine((value, ctx) => {
  if (value.fromBlockId === value.toBlockId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Edge endpoints must differ", path: ["toBlockId"] });
  }
});
export type CreateRoadmapBlockEdge = z.infer<typeof createRoadmapBlockEdgeSchema>;

export const promoteRoadmapBlockSchema = z.object({
  level: z.enum(["initiative", "epic"]),
  parentGoalId: z.string().uuid().optional().nullable(),
  title: z.string().min(1).max(200).optional(),
});
export type PromoteRoadmapBlock = z.infer<typeof promoteRoadmapBlockSchema>;
