import { z } from "zod";

export const AUTO_LABEL_TRIGGER_EVENTS = [
  "issue.created",
  "issue.updated",
  "comment.created",
  "work_product.registered",
] as const;

export const AUTO_LABEL_RULE_ACTIONS = ["apply", "remove", "toggle"] as const;

export const autoLabelTriggerEventSchema = z.enum(AUTO_LABEL_TRIGGER_EVENTS);
export const autoLabelRuleActionSchema = z.enum(AUTO_LABEL_RULE_ACTIONS);

export const createAutoLabelRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  triggerEvent: autoLabelTriggerEventSchema,
  conditionExpression: z.string().trim().min(1).max(2000),
  action: autoLabelRuleActionSchema,
  labelId: z.string().uuid(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10000).default(0),
});

export type CreateAutoLabelRule = z.infer<typeof createAutoLabelRuleSchema>;

export const updateAutoLabelRuleSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  triggerEvent: autoLabelTriggerEventSchema.optional(),
  conditionExpression: z.string().trim().min(1).max(2000).optional(),
  action: autoLabelRuleActionSchema.optional(),
  labelId: z.string().uuid().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(10000).optional(),
});

export type UpdateAutoLabelRule = z.infer<typeof updateAutoLabelRuleSchema>;

export const dryRunAutoLabelRuleSchema = z.object({
  issueId: z.string().uuid(),
});

export type DryRunAutoLabelRule = z.infer<typeof dryRunAutoLabelRuleSchema>;
