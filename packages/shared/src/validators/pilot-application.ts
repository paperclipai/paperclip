import { z } from "zod";

export const PILOT_PRACTICE_TYPES = ["therapist", "coach", "holistic_practitioner"] as const;
export const PILOT_CAP = 10;

export const createPilotApplicationSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  practiceType: z.enum(PILOT_PRACTICE_TYPES),
  description: z.string().min(1).max(500),
});

export type CreatePilotApplication = z.infer<typeof createPilotApplicationSchema>;
