import { z } from "zod";

export const webhookEndpointProviderSchema = z.enum(["github", "slack", "email", "generic"]);
export const webhookEndpointStatusSchema = z.enum(["active", "paused", "disabled"]);
export const eventRoutingSourceSchema = z.enum(["webhook", "internal"]);

export const createWebhookEndpointSchema = z.object({
  name: z.string().trim().min(1),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "Slug must be lowercase alphanumeric with -/_"),
  provider: webhookEndpointProviderSchema.optional().default("generic"),
  secret: z.string().trim().min(8).optional(),
  status: webhookEndpointStatusSchema.optional().default("active"),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export const updateWebhookEndpointSchema = createWebhookEndpointSchema.partial();

export const eventRoutingRuleConditionSchema = z.record(z.unknown());
export const eventRoutingRuleActionSchema = z.record(z.unknown());

export const createEventRoutingRuleSchema = z.object({
  endpointId: z.string().uuid().optional().nullable(),
  source: eventRoutingSourceSchema.optional().default("webhook"),
  name: z.string().trim().min(1),
  priority: z.number().int().optional().default(100),
  condition: eventRoutingRuleConditionSchema,
  action: eventRoutingRuleActionSchema,
  cooldownSec: z.number().int().min(0).optional().default(0),
  enabled: z.boolean().optional().default(true),
});

export const updateEventRoutingRuleSchema = createEventRoutingRuleSchema.partial();

export const webhookReceiveQuerySchema = z.object({
  idempotencyKey: z.string().optional(),
});

export type CreateWebhookEndpoint = z.infer<typeof createWebhookEndpointSchema>;
export type UpdateWebhookEndpoint = z.infer<typeof updateWebhookEndpointSchema>;
export type CreateEventRoutingRule = z.infer<typeof createEventRoutingRuleSchema>;
export type UpdateEventRoutingRule = z.infer<typeof updateEventRoutingRuleSchema>;
