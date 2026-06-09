import { z } from "zod";

export const awaitingHumanProviderSchema = z.enum(["clickup"]);

export const clickupAwaitingHumanProviderConfigSchema = z.object({
  workspaceId: z.string().min(1).max(200).nullable(),
  channelId: z.string().min(1).max(200).nullable(),
  attachmentTaskId: z.string().min(1).max(200).nullable().optional(),
  primaryReviewerUserId: z.string().min(1).max(200).nullable().optional(),
  secondaryReviewerUserId: z.string().min(1).max(200).nullable().optional(),
});

export const companyAwaitingHumanSettingsSchema = z.object({
  companyId: z.string().uuid(),
  enabled: z.boolean(),
  provider: awaitingHumanProviderSchema.nullable(),
  providerConfig: clickupAwaitingHumanProviderConfigSchema.nullable(),
  hasStoredAuthToken: z.boolean(),
  createdAt: z.coerce.date().nullable(),
  updatedAt: z.coerce.date().nullable(),
});

export const patchCompanyAwaitingHumanSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: awaitingHumanProviderSchema.nullable().optional(),
  providerConfig: clickupAwaitingHumanProviderConfigSchema.nullable().optional(),
  clickupPersonalToken: z.string().min(1).optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.provider === null && value.providerConfig != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providerConfig"],
      message: "providerConfig can only be set when provider is clickup",
    });
  }
});

export type CompanyAwaitingHumanSettings = z.infer<typeof companyAwaitingHumanSettingsSchema>;
export type PatchCompanyAwaitingHumanSettings = z.infer<typeof patchCompanyAwaitingHumanSettingsSchema>;
