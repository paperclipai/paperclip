import { z } from "zod";
import { isAbsolutePath } from "../absolute-path.js";
import {
  COMPANY_STATUSES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "../constants.js";

const logoAssetIdSchema = z.string().uuid().nullable().optional();
const brandColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const feedbackDataSharingTermsVersionSchema = z.string().min(1).nullable().optional();
const attachmentMaxBytesSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_COMPANY_ATTACHMENT_MAX_BYTES);

// Company-level default agent working directory. New agents inherit this into
// adapterConfig.cwd unless they are created with an explicit cwd. Must be an
// absolute path — POSIX ("/workbench") or Windows drive-letter ("C:\\workbench").
//
// null vs undefined semantics (this schema is `.nullable().optional()`):
//   - a non-empty absolute string sets the default
//   - `null` explicitly clears the default
//   - `undefined` (field omitted) leaves the existing value unchanged on update
export const defaultAgentCwdSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsolutePath, "Default agent workspace must be an absolute path")
  .nullable()
  .optional();

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
  defaultAgentCwd: defaultAgentCwdSchema,
  defaultResponsibleUserId: z.string().min(1).nullable().optional(),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    feedbackDataSharingEnabled: z.boolean().optional(),
    feedbackDataSharingConsentAt: z.coerce.date().nullable().optional(),
    feedbackDataSharingConsentByUserId: z.string().min(1).nullable().optional(),
    feedbackDataSharingTermsVersion: feedbackDataSharingTermsVersionSchema,
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
    attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;

export const updateCompanyBrandingSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.description !== undefined
      || value.brandColor !== undefined
      || value.logoAssetId !== undefined,
    "At least one branding field must be provided",
  );

export type UpdateCompanyBranding = z.infer<typeof updateCompanyBrandingSchema>;

// Fields a same-company CEO agent (not just a human board member) may update via
// PATCH /companies/:companyId. Superset of branding plus the default agent
// workspace so agents can manage the org default without a human in the loop.
export const updateCompanyByAgentSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
    defaultAgentCwd: defaultAgentCwdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.description !== undefined
      || value.brandColor !== undefined
      || value.logoAssetId !== undefined
      || value.defaultAgentCwd !== undefined,
    "At least one company field must be provided",
  );

export type UpdateCompanyByAgent = z.infer<typeof updateCompanyByAgentSchema>;
