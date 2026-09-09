import { z } from "zod";

export const WEBHOOK_EVENT_TYPES = [
  "alert.created",
  "alert.resolved",
  "alert.escalated",
  "frs.threshold_exceeded",
  "frs.threshold_cleared",
  "annotation.created",
  "incident.opened",
  "incident.closed",
] as const;

export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

export const createWebhookSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().url().max(2000),
  eventTypes: z.array(webhookEventTypeSchema).min(1).max(20),
  active: z.boolean().optional().default(true),
});

export const updateWebhookSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  url: z.string().url().max(2000).optional(),
  eventTypes: z.array(webhookEventTypeSchema).min(1).max(20).optional(),
  active: z.boolean().optional(),
});

export type CreateWebhook = z.infer<typeof createWebhookSchema>;
export type UpdateWebhook = z.infer<typeof updateWebhookSchema>;
