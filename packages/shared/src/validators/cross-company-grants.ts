import { z } from "zod";
import {
  CROSS_COMPANY_ELIGIBLE_ACTIONS,
  CROSS_COMPANY_GRANT_MAX_TTL_HOURS,
} from "../constants.js";

const crossCompanyActionSchema = z.enum(CROSS_COMPANY_ELIGIBLE_ACTIONS);

export const crossCompanyGrantScopeSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    issueIds: z.array(z.string().uuid()).optional(),
  })
  .strict()
  .optional()
  .nullable();

export const requestCrossCompanyGrantSchema = z.object({
  targetCompanyId: z.string().uuid(),
  actions: z.array(crossCompanyActionSchema).min(1),
  scope: crossCompanyGrantScopeSchema,
  budgetCapCents: z.number().int().min(0).optional().nullable(),
  ttlHours: z.number().int().min(1).max(CROSS_COMPANY_GRANT_MAX_TTL_HOURS),
  justification: z.string().min(1),
});

export type RequestCrossCompanyGrant = z.infer<typeof requestCrossCompanyGrantSchema>;

export const issueCrossCompanyGrantSchema = z.object({
  granteeAgentId: z.string().uuid(),
  granteeHomeCompanyId: z.string().uuid(),
  actions: z.array(crossCompanyActionSchema).min(1),
  scope: crossCompanyGrantScopeSchema,
  budgetCapCents: z.number().int().min(0).optional().nullable(),
  ttlHours: z.number().int().min(1).max(CROSS_COMPANY_GRANT_MAX_TTL_HOURS),
});

export type IssueCrossCompanyGrant = z.infer<typeof issueCrossCompanyGrantSchema>;
