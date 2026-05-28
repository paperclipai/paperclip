import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "../constants.js";

export const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
  metadataFilter: z.record(z.unknown()).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  secret: z.string().min(16).max(256).optional(),
});

export type CreateWebhook = z.infer<typeof createWebhookSchema>;
