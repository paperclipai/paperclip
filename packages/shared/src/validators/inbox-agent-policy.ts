import { z } from "zod";

export const inboxAgentPolicyModeSchema = z.enum(["open", "allowlist", "disabled"]);

export const updateInboxAgentPolicySchema = z.object({
  mode: inboxAgentPolicyModeSchema,
  allowedAgentIds: z.array(z.string().uuid()).max(100).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.mode !== "allowlist" && value.allowedAgentIds.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: "allowedAgentIds must be empty when mode is not \"allowlist\"",
      path: ["allowedAgentIds"],
    });
  }
});

export type UpdateInboxAgentPolicy = z.infer<typeof updateInboxAgentPolicySchema>;
