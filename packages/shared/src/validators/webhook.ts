import { z } from "zod";

export const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
  enabled: z.boolean().optional().default(true),
});

export type CreateWebhook = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z.object({
  url: z.string().url().max(2048).optional(),
  events: z.array(z.string().trim().min(1).max(100)).min(1).max(50).optional(),
  enabled: z.boolean().optional(),
});

export type UpdateWebhook = z.infer<typeof updateWebhookSchema>;

export const rotateWebhookSecretSchema = z.object({});

export type RotateWebhookSecret = z.infer<typeof rotateWebhookSecretSchema>;
