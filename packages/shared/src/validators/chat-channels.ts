import { z } from "zod";
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
export const chatResourceAvailabilitySchema = z.enum(CHAT_RESOURCE_AVAILABILITIES);

export const createChatEndpointSchema = z.object({
  provider: chatProviderSchema,
  assignedAgentId: z.string().uuid(),
  applicationId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160).optional(),
}).strict();

export const updateChatEndpointSchema = z.object({
  allowDirectMessages: z.boolean().optional(),
  allowGroupChats: z.boolean().optional(),
  allowUnlinkedPeople: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one chat endpoint field is required",
});

export const configureChatEndpointSchema = z.object({
  action: z.enum(["configure", "verify", "pause", "resume", "reconnect", "remove"]),
  credentials: z.record(z.string(), z.string().min(1)).optional(),
}).strict();

export const replaceChatEndpointResourcesSchema = z.object({
  resources: z.array(z.object({
    id: z.string().uuid(),
    enabled: z.boolean(),
  }).strict()).max(500),
}).strict();

export const publishChatCommentSchema = z.object({
  commentId: z.string().uuid(),
}).strict();

export const createChatIdentityLinkIntentSchema = z.object({
  expiresInSeconds: z.number().int().min(300).max(86_400).default(1_800),
}).strict().default({ expiresInSeconds: 1_800 });

export const confirmChatIdentityLinkSchema = z.object({
  token: z.string().min(32).max(4096),
}).strict();

export const replayChatDeliverySchema = z.object({}).strict();

export const chatPublicEndpointIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{32,128}$/);
