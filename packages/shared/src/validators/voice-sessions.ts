import { z } from "zod";
export const startVoiceSessionSchema = z.object({
  endpointId: z.string().uuid(),
  issueId: z.string().uuid().optional(),
  newConversation: z.boolean().optional(),
  idempotencyKey: z.string().uuid(),
  maxDurationSeconds: z.number().int().min(30).max(1800).default(600),
}).strict().refine((value) => !(value.issueId && value.newConversation), { message: "Choose an existing task or a new conversation", path: ["newConversation"] });
export const voiceCallbackPreferenceSchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, "Use an international phone number, such as +12015551234"),
  enabled: z.boolean(),
}).strict();
export const voiceSessionCursorSchema = z.object({ cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict();

export const voicePhoneConfigurationSchema = z.object({ numberId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), enabled: z.boolean(), guestIntake: z.boolean().default(false), lowTrustEnvironmentId: z.string().uuid().nullable().optional() }).strict();
export const voiceInboundDecisionSchema = z.object({ approve: z.boolean(), approvalCode: z.string().regex(/^[0-9]{6}$/), issueId: z.string().uuid().optional() }).strict();
