import { z } from "zod";
import { AGENT_ADAPTER_TYPES } from "../constants.js";
import { ADAPTER_AUTH_SESSION_STATUSES } from "../types/agent.js";

const isoDateTime = z.union([z.date(), z.string().datetime()]);

// The public status schema. It accepts only the six public statuses. It rejects
// an unknown status and both internal states (`promoting`, `cleanup_pending`).
export const adapterAuthSessionStatusSchema = z.enum(ADAPTER_AUTH_SESSION_STATUSES);
export type AdapterAuthSessionStatus = z.infer<typeof adapterAuthSessionStatusSchema>;

export const adapterAuthSessionFailureSchema = z.object({
  reason: z.string().min(1).max(200),
  message: z.string().min(1).max(1000).nullable(),
}).strict();
export type AdapterAuthSessionFailure = z.infer<typeof adapterAuthSessionFailureSchema>;

// The public response schema. `.strict()` rejects an extra field, so a prompt, a
// token, an account identifier, or a provider lease identifier never validates.
export const adapterAuthSessionResponseSchema = z.object({
  sessionId: z.string().guid(),
  environmentId: z.string().guid(),
  status: adapterAuthSessionStatusSchema,
  expiresAt: isoDateTime.nullable(),
  failure: adapterAuthSessionFailureSchema.nullable(),
}).strict();
export type AdapterAuthSessionResponse = z.infer<typeof adapterAuthSessionResponseSchema>;

export const adapterAuthSessionPromptSchema = z.object({
  url: z.string().min(1),
  code: z.string().min(1),
}).strict();
export type AdapterAuthSessionPrompt = z.infer<typeof adapterAuthSessionPromptSchema>;

// The owner read schema. It adds the one-time prompt to the public response.
export const adapterAuthSessionOwnerResponseSchema = adapterAuthSessionResponseSchema.extend({
  prompt: adapterAuthSessionPromptSchema.nullable(),
}).strict();
export type AdapterAuthSessionOwnerResponse =
  z.infer<typeof adapterAuthSessionOwnerResponseSchema>;

export const startAdapterAuthSessionRequestSchema = z.object({
  environmentId: z.string().guid(),
  adapterType: z.enum(AGENT_ADAPTER_TYPES),
  ttlSeconds: z.number().int().min(60).max(24 * 60 * 60).optional(),
}).strict();
export type StartAdapterAuthSessionRequest =
  z.infer<typeof startAdapterAuthSessionRequestSchema>;
