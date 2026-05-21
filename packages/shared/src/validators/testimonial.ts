import { z } from "zod";

export const createTestimonialSchema = z.object({
  authorName: z.string().trim().min(1).max(255),
  authorRole: z.string().trim().max(255).nullable().optional(),
  authorAvatarUrl: z.string().url().max(2000).nullable().optional(),
  content: z.string().trim().min(1).max(5000),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  sortOrder: z.number().int().default(0),
  isPublished: z.boolean().default(false),
});

export const testimonialSchema = createTestimonialSchema;
export const updateTestimonialSchema = createTestimonialSchema.partial();
export type TestimonialInput = z.infer<typeof createTestimonialSchema>;
export type UpdateTestimonialInput = z.infer<typeof updateTestimonialSchema>;
