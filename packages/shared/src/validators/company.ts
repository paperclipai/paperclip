import { z } from "zod";
import { COMPANY_STATUSES } from "../constants.js";

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const companySettingsSchema = z.object({
  telegram: z.object({
    chatId: z.string().optional(),
    forumChatId: z.string().optional(),
    defaultAssigneeAgentId: z.string().uuid().optional(),
    notificationLevel: z.enum(["all", "important", "critical"]).optional(),
  }).optional(),
}).optional();

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    settings: companySettingsSchema,
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;
