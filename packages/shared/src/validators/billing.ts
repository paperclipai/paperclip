import { z } from "zod";

export const createCheckoutSessionSchema = z.object({
  plan: z.enum(["starter", "pro", "enterprise"]),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

export type CreateCheckoutSession = z.infer<typeof createCheckoutSessionSchema>;
