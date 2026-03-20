import { z } from "zod";
import { COMPANY_STATUSES } from "../constants.js";

const logoAssetIdSchema = z.string().uuid().nullable().optional();

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    logoAssetId: logoAssetIdSchema,
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;

/** Branding-only subset that CEO agents may update. */
export const updateCompanyBrandingSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  logoAssetId: logoAssetIdSchema,
});

export type UpdateCompanyBranding = z.infer<typeof updateCompanyBrandingSchema>;
