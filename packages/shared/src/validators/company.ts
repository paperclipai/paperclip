import { z } from "zod";
import { COMPANY_STATUSES } from "../constants.js";

const logoUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .regex(/^\/api\/assets\/[^\s]+$|^https?:\/\/[^\s]+$/)
  .nullable()
  .optional();

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  logoUrl: logoUrlSchema,
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    logoUrl: logoUrlSchema,
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;
