import { z } from "zod";
import { MODEL_PROFILE_KEYS } from "@paperclipai/shared";
import type { ModelPolicyRule } from "./model-policy.ts";

const stringArray = z.array(z.string());

const matchSchema = z
  .object({
    agentRole: stringArray.optional(),
    wakeReason: stringArray.optional(),
    issuePriority: stringArray.optional(),
    workMode: stringArray.optional(),
  })
  .strict();

const ruleSchema = z
  .object({
    when: matchSchema,
    modelProfile: z.enum(MODEL_PROFILE_KEYS as unknown as [string, ...string[]]),
    reason: z.string().optional(),
  })
  .strict();

export const modelPolicyRulesSchema = z.array(ruleSchema);

export function parseModelPolicyRules(value: unknown): ModelPolicyRule[] {
  return modelPolicyRulesSchema.parse(value) as ModelPolicyRule[];
}
