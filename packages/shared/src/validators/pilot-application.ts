import { z } from "zod";

export const PILOT_PRACTICE_TYPES = [
  "therapist",
  "coach",
  "holistic_practitioner",
] as const;

export type PilotPracticeType = (typeof PILOT_PRACTICE_TYPES)[number];

export const pilotApplicationSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  practiceType: z.enum(PILOT_PRACTICE_TYPES),
  description: z.string().min(1).max(2000),
});

export type PilotApplication = z.infer<typeof pilotApplicationSchema>;
