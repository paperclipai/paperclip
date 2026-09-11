import type { Message } from "chat";
import { z } from "zod";

const opaqueId = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\x00-\x20\x7f]+$/);
const generation = z.number().int().min(0).max(2_147_483_647);
const eventId = z
  .string()
  .min(1)
  .max(2500)
  .regex(/^[^\x00-\x20\x7f]+$/);
const scopeFields = {
  companyId: z.uuid(),
  endpointId: z.uuid(),
  runtimeGeneration: generation,
  credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  tenantId: z.uuid(),
  botAppId: z.uuid(),
  providerEventId: eventId,
};
const admissionSchema = z
  .object({
    ...scopeFields,
    threadId: z.string().min(1).max(8192),
    isDirectMessage: z.literal(true),
  })
  .strict();
const recipientSchema = z
  .object({
    schema: z.literal("paperclip.teams.personal-recipient.v1"),
    ...scopeFields,
    aadObjectId: z.uuid(),
    providerUserId: opaqueId,
    providerConversationId: opaqueId,
    providerActivityId: opaqueId,
  })
  .strict();
const bindingFields = {
  deliveryId: z.uuid(),
  principalId: z.uuid(),
  conversationId: z.uuid(),
  conversationGeneration: generation.min(1),
};
const bindingScopeSchema = z
  .object({
    admission: admissionSchema,
    ...bindingFields,
    externalPrincipalId: z.uuid(),
  })
  .strict();
const bindingSchema = z
  .object({
    schema: z.literal("paperclip.teams.personal-recipient-binding.v1"),
    recipient: recipientSchema,
    ...bindingFields,
  })
  .strict();
const activitySchema = z.object({
  type: z.literal("message"),
  channelId: z.literal("msteams"),
  id: opaqueId,
  from: z.object({
    id: opaqueId,
    aadObjectId: z.uuid(),
    role: z.enum(["user"]).optional(),
  }),
  recipient: z.object({
    id: opaqueId,
    isTargeted: z.literal(false).optional(),
  }),
  conversation: z.object({
    id: opaqueId,
    conversationType: z.literal("personal"),
    tenantId: z.uuid().optional(),
    isGroup: z.literal(false).optional(),
  }),
  channelData: z
    .object({
      tenant: z.object({ id: z.uuid() }).optional(),
      team: z.never().optional(),
      channel: z.never().optional(),
    })
    .optional(),
});

export type TeamsPersonalRecipientAdmission = Omit<
  z.infer<typeof admissionSchema>,
  "isDirectMessage"
> & {
  isDirectMessage: boolean;
};
export type TeamsPersonalRecipient = Readonly<z.infer<typeof recipientSchema>>;
export type TeamsPersonalRecipientBindingScope = Omit<
  z.infer<typeof bindingScopeSchema>,
  "admission"
> & {
  admission: TeamsPersonalRecipientAdmission;
};
export type TeamsPersonalRecipientBinding = Readonly<
  Omit<z.infer<typeof bindingSchema>, "recipient"> & {
    recipient: TeamsPersonalRecipient;
  }
>;

// A route-free ID is Paperclip's durable identity. The pinned SDK's routed
// form may omit its personal suffix. Neither that omission nor any prefix
// (including a:) establishes personal scope; only the admitted proof does.
function conversationFromThread(threadId: string): string | null {
  const parts = threadId.split(":");
  if (parts[0] !== "teams" || parts.length < 2 || parts.length > 4) return null;
  if (parts.length === 4 && parts[3] !== "personal") return null;
  if (parts.length === 3 && ["groupChat", "channel"].includes(parts[2]!))
    return null;
  const bytes = Buffer.from(parts[1]!, "base64url");
  const decoded = bytes.toString("utf8");
  if (
    bytes.toString("base64url") !== parts[1] ||
    !Buffer.from(decoded, "utf8").equals(bytes) ||
    !opaqueId.safeParse(decoded).success ||
    decoded.includes(";messageid=")
  )
    return null;
  return decoded;
}

function canonicalEventId(conversationId: string, activityId: string): string {
  return `teams:${Buffer.from(conversationId).toString("base64url")}:${activityId}`;
}

/**
 * Data/provenance validation only, NOT JWT or database authorization. Call only
 * at the runtime-authenticated message admission boundary, using independently
 * verified endpoint tenant/app and the current runtime fence. Never call on a
 * reconstructed Message (whose raw activity has intentionally been discarded).
 */
export function deriveTeamsPersonalRecipient(
  message: Pick<Message, "id" | "threadId" | "author" | "raw">,
  scope: TeamsPersonalRecipientAdmission,
): TeamsPersonalRecipient | null {
  const expected = admissionSchema.safeParse(scope);
  const activity = activitySchema.safeParse(message.raw);
  if (!expected.success || !activity.success) return null;
  const a = activity.data;
  const tenant = a.conversation.tenantId ?? a.channelData?.tenant?.id;
  if (
    tenant !== expected.data.tenantId ||
    (a.channelData?.tenant?.id !== undefined &&
      a.channelData.tenant.id !== tenant) ||
    a.recipient.id !== `28:${expected.data.botAppId}` ||
    a.from.id === expected.data.botAppId ||
    a.from.id === a.recipient.id ||
    message.id !== a.id ||
    message.author.userId !== a.from.id ||
    message.author.isMe ||
    message.author.isBot ||
    message.author.isSystem ||
    conversationFromThread(message.threadId) !== a.conversation.id
  )
    return null;
  return parseTeamsPersonalRecipient(
    {
      schema: "paperclip.teams.personal-recipient.v1",
      companyId: expected.data.companyId,
      endpointId: expected.data.endpointId,
      runtimeGeneration: expected.data.runtimeGeneration,
      credentialFingerprint: expected.data.credentialFingerprint,
      tenantId: tenant,
      botAppId: expected.data.botAppId,
      providerEventId: expected.data.providerEventId,
      aadObjectId: a.from.aadObjectId,
      providerUserId: a.from.id,
      providerConversationId: a.conversation.id,
      providerActivityId: a.id,
    },
    expected.data,
  );
}

/**
 * Read an existing proof only from the admitted delivery. `scope` must come
 * from independently loaded endpoint/delivery/runtime-origin facts, not this
 * JSON object. Missing legacy proof fails closed; SDK routing caches and an
 * AAD-only rehydrated author cannot replace it. Routes are deliberately absent.
 */
export function parseTeamsPersonalRecipient(
  input: unknown,
  scope: TeamsPersonalRecipientAdmission,
): TeamsPersonalRecipient | null {
  const expected = admissionSchema.safeParse(scope);
  const parsed = recipientSchema.safeParse(input);
  if (!expected.success || !parsed.success) return null;
  const p = parsed.data;
  for (const key of Object.keys(scopeFields) as (keyof typeof scopeFields)[]) {
    if (p[key] !== expected.data[key]) return null;
  }
  if (
    conversationFromThread(expected.data.threadId) !==
      p.providerConversationId ||
    p.providerEventId !==
      canonicalEventId(p.providerConversationId, p.providerActivityId) ||
    p.providerUserId === p.botAppId ||
    p.providerUserId === `28:${p.botAppId}`
  )
    return null;
  return Object.freeze(p);
}

/**
 * Bind after the service has locked and authorized the processed delivery,
 * principal and exact conversation generation. This function does not query
 * the database, select a recipient, authorize a sponsor, or grant file access.
 */
export function bindTeamsPersonalRecipient(
  input: unknown,
  scope: TeamsPersonalRecipientBindingScope,
): TeamsPersonalRecipientBinding | null {
  const expected = bindingScopeSchema.safeParse(scope);
  if (!expected.success) return null;
  const recipient = parseTeamsPersonalRecipient(input, expected.data.admission);
  if (!recipient || recipient.aadObjectId !== expected.data.externalPrincipalId)
    return null;
  return Object.freeze({
    schema: "paperclip.teams.personal-recipient-binding.v1",
    recipient,
    deliveryId: expected.data.deliveryId,
    principalId: expected.data.principalId,
    conversationId: expected.data.conversationId,
    conversationGeneration: expected.data.conversationGeneration,
  });
}

export function parseTeamsPersonalRecipientBinding(
  input: unknown,
  scope: TeamsPersonalRecipientBindingScope,
): TeamsPersonalRecipientBinding | null {
  const parsed = bindingSchema.safeParse(input);
  if (!parsed.success) return null;
  const expected = bindTeamsPersonalRecipient(parsed.data.recipient, scope);
  if (!expected) return null;
  for (const key of Object.keys(
    bindingFields,
  ) as (keyof typeof bindingFields)[]) {
    if (parsed.data[key] !== expected[key]) return null;
  }
  return expected;
}
