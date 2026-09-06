import { z } from "zod";
import { multilineTextSchema } from "./text.js";
import {
  CHAT_CONCURRENCY_POLICIES,
  CHAT_DELIVERY_STATES,
  CHAT_ENDPOINT_STATUSES,
  CHAT_EVENT_KINDS,
  CHAT_IDENTITY_LINK_STATUSES,
  CHAT_PRINCIPAL_KINDS,
  CHAT_PROVIDERS,
  CHAT_PUBLICATION_STATES,
  CHAT_RESOURCE_AVAILABILITIES,
} from "../types/chat-channels.js";

export const chatProviderSchema = z.enum(CHAT_PROVIDERS);
export const chatEndpointStatusSchema = z.enum(CHAT_ENDPOINT_STATUSES);
export const chatConcurrencyPolicySchema = z.enum(CHAT_CONCURRENCY_POLICIES);
export const chatEventKindSchema = z.enum(CHAT_EVENT_KINDS);
export const chatDeliveryStateSchema = z.enum(CHAT_DELIVERY_STATES);
export const chatPublicationStateSchema = z.enum(CHAT_PUBLICATION_STATES);
export const chatPrincipalKindSchema = z.enum(CHAT_PRINCIPAL_KINDS);
export const chatIdentityLinkStatusSchema = z.enum(CHAT_IDENTITY_LINK_STATUSES);
export const chatResourceAvailabilitySchema = z.enum(
  CHAT_RESOURCE_AVAILABILITIES,
);

/**
 * Microsoft emits Entra application and tenant identifiers in canonical UUID
 * form in Bot Framework activities. Tenant aliases such as `common` or an
 * `onmicrosoft.com` domain can be accepted by the token endpoint, but cannot
 * be compared safely with the activity tenant id used by Paperclip's runtime
 * fence. Normalize the UUIDs at the API boundary instead.
 */
export const microsoftTeamsCredentialIdSchema = z
  .string()
  .trim()
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000", {
    message: "Microsoft Teams credential IDs cannot be the nil UUID",
  })
  .transform((value) => value.toLowerCase());

const chatEndpointCredentialsSchema = z
  .record(z.string(), z.string().min(1))
  .superRefine((credentials, ctx) => {
    for (const key of ["clientId", "tenantId"] as const) {
      const value = credentials[key];
      if (value === undefined) continue;
      const parsed = microsoftTeamsCredentialIdSchema.safeParse(value);
      if (parsed.success) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must be a canonical Microsoft Entra UUID`,
      });
    }
  })
  .transform((credentials) => {
    const normalized = { ...credentials };
    for (const key of ["clientId", "tenantId"] as const) {
      const value = normalized[key];
      if (value !== undefined) {
        normalized[key] = microsoftTeamsCredentialIdSchema.parse(value);
      }
    }
    return normalized;
  });

export const createChatEndpointSchema = z
  .object({
    provider: chatProviderSchema,
    assignedAgentId: z.string().uuid(),
    applicationId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const updateChatEndpointSchema = z
  .object({
    allowDirectMessages: z.boolean().optional(),
    allowGroupChats: z.boolean().optional(),
    allowUnlinkedPeople: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one chat endpoint field is required",
  });

export const configureChatEndpointSchema = z
  .object({
    action: z.enum([
      "configure",
      "verify",
      "pause",
      "resume",
      "reconnect",
      "remove",
    ]),
    credentials: chatEndpointCredentialsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.credentials &&
      value.action !== "configure" &&
      value.action !== "reconnect"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentials"],
        message: `Credentials are not accepted for the ${value.action} action`,
      });
    }
  });

export const replaceChatEndpointResourcesSchema = z
  .object({
    resources: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const publishChatCommentSchema = z
  .object({
    commentId: z.string().uuid(),
  })
  .strict();

export const publishChatBoardMessageSchema = z
  .object({
    body: multilineTextSchema.pipe(z.string().trim().min(1).max(100_000)),
    idempotencyKey: z.string().trim().min(16).max(200),
  })
  .strict();

export const publishChatPublicationSchema = z.union([
  publishChatCommentSchema,
  publishChatBoardMessageSchema,
]);

export const resolveChatPublicationSchema = z
  .object({
    action: z.enum(["mark_delivered", "retry_anyway", "cancel"]),
  })
  .strict();

export const resolveChatActionSchema = z
  .object({
    action: z.enum(["mark_delivered", "retry_anyway", "cancel"]),
  })
  .strict();

export const createChatIdentityLinkIntentSchema = z
  .object({
    expiresInSeconds: z.number().int().min(300).max(86_400).default(1_800),
  })
  .strict()
  .default({ expiresInSeconds: 1_800 });

export const confirmChatIdentityLinkSchema = z
  .object({
    token: z.string().min(32).max(4096),
  })
  .strict();

export const replayChatDeliverySchema = z.object({}).strict();

export const chatPublicEndpointIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{32,128}$/);
