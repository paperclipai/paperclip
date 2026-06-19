import { z } from "zod";

export const createMilestoneSchema = z.object({
  name: z.string().min(1),
  projectId: z.string().uuid().optional().nullable(),
  description: z.string().optional().nullable(),
  targetDate: z.string().optional().nullable(),
  sortOrder: z.number().int().optional(),
});

export type CreateMilestone = z.infer<typeof createMilestoneSchema>;

export const updateMilestoneSchema = createMilestoneSchema.partial();

export type UpdateMilestone = z.infer<typeof updateMilestoneSchema>;
