import { z } from "zod";
import {
  BRIEFING_FEEDBACK_RATINGS,
  BRIEFING_FEEDBACK_CATEGORIES,
} from "../types/briefing-feedback.js";

export const briefingFeedbackRatingSchema = z.enum(BRIEFING_FEEDBACK_RATINGS);
export const briefingFeedbackCategorySchema = z.enum(BRIEFING_FEEDBACK_CATEGORIES);

export const submitBriefingFeedbackSchema = z.object({
  briefingId: z.string().min(1),
  userId: z.string().min(1),
  rating: briefingFeedbackRatingSchema,
  category: briefingFeedbackCategorySchema.optional().nullable(),
  freeText: z.string().max(5000).optional().nullable(),
});

export type SubmitBriefingFeedback = z.infer<typeof submitBriefingFeedbackSchema>;
