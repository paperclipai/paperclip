import { z } from "zod";

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(200),
});

export type CreateOrganization = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  settings: z.record(z.unknown()).optional(),
});

export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;

export const addOrgMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["owner", "admin", "member"]).optional().default("member"),
});

export type AddOrgMember = z.infer<typeof addOrgMemberSchema>;
