import { z } from "zod";

export const templateCompanySchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string(),
  agents_count: z.number().int().nonnegative(),
  skills_count: z.number().int().nonnegative(),
  tags: z.array(z.string()).default([]),
  url: z.string().url(),
  readme_excerpt: z.string().optional(),
});

export const templateRegistrySchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  source: z.string().url(),
  companies: z.array(templateCompanySchema),
});

export type TemplateCompany = z.infer<typeof templateCompanySchema>;
export type TemplateRegistry = z.infer<typeof templateRegistrySchema>;

export interface TemplateInstallRequest {
  slug: string;
}

export interface TemplateInstallResponse {
  companyId: string;
  name: string;
  agentsCreated: number;
}
