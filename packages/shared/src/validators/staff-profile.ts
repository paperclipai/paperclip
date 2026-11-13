import { z } from "zod";
import { orgPrincipalRefSchema } from "../org-principal.js";

export const updateCompanyStaffProfileSchema = z.object({
  jobTitle: z.string().trim().max(200).nullable().optional(),
  orgRole: z.string().trim().max(120).nullable().optional(),
  capabilities: z.string().trim().max(8000).nullable().optional(),
  reportsTo: orgPrincipalRefSchema.nullable().optional(),
}).strict();

export type UpdateCompanyStaffProfile = z.infer<typeof updateCompanyStaffProfileSchema>;
