import { z } from "zod";

export const companyRolloutCreateSchema = z.object({
  title: z.string().min(1),
  notes: z.string().optional().nullable(),
  selectedFiles: z.array(z.string().min(1)).optional(),
});

export type CompanyRolloutCreate = z.infer<typeof companyRolloutCreateSchema>;

export const companyRolloutTargetSelectionSchema = z.object({
  targetCompanyIds: z.array(z.string().uuid()).optional(),
});

export type CompanyRolloutTargetSelection = z.infer<typeof companyRolloutTargetSelectionSchema>;
