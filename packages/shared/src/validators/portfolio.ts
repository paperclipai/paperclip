import { z } from "zod";

export const createPortfolioItemSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(5000).nullable().optional(),
  imageUrl: z.string().url().max(2000).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  tags: z.array(z.string().trim().max(100)).nullable().optional(),
  clientName: z.string().trim().max(255).nullable().optional(),
  projectUrl: z.string().url().max(2000).nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  sortOrder: z.number().int().default(0),
  isPublished: z.boolean().default(false),
});

export const portfolioItemSchema = createPortfolioItemSchema;
export const updatePortfolioItemSchema = createPortfolioItemSchema.partial();
export type PortfolioItemInput = z.infer<typeof createPortfolioItemSchema>;
export type UpdatePortfolioItemInput = z.infer<typeof updatePortfolioItemSchema>;
