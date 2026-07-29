import { z } from "zod";
import {
  CHANNEL_CARD_KINDS,
  CHANNEL_WORK_MODES,
  PRINCIPAL_TYPES,
} from "../constants.js";

export const createChannelSchema = z.object({
  kind: z.enum(["public", "private"]),
  name: z.string().min(1).max(80),
  topic: z.string().max(500).nullable().optional(),
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
});
export type CreateChannel = z.infer<typeof createChannelSchema>;

export const createDmChannelSchema = z.object({
  principalType: z.enum(PRINCIPAL_TYPES),
  principalId: z.string().min(1),
});
export type CreateDmChannel = z.infer<typeof createDmChannelSchema>;

export const updateChannelSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  topic: z.string().max(500).nullable().optional(),
  archivedAt: z.coerce.date().nullable().optional(),
});
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

export const postChannelMessageSchema = z.object({
  body: z.string().max(100_000).default(""),
  threadRootId: z.string().uuid().nullable().optional(),
  replyToId: z.string().uuid().nullable().optional(),
  channelWorkMode: z.enum(CHANNEL_WORK_MODES).optional().default("ask"),
  issueId: z.string().uuid().nullable().optional(),
  cardKind: z.enum(CHANNEL_CARD_KINDS).nullable().optional(),
  mentionedAgentIds: z.array(z.string().uuid()).optional(),
  mentionedUserIds: z.array(z.string().min(1)).optional(),
});
export type PostChannelMessage = z.infer<typeof postChannelMessageSchema>;

export const createIssueFromChannelMessageSchema = z.object({
  title: z.string().min(1).max(500),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  wakeAssignee: z.boolean().optional().default(true),
  workMode: z.enum(["standard", "ask", "planning"]).optional().default("standard"),
});
export type CreateIssueFromChannelMessage = z.infer<typeof createIssueFromChannelMessageSchema>;

export const markChannelReadSchema = z.object({
  messageId: z.string().uuid().optional(),
});
export type MarkChannelRead = z.infer<typeof markChannelReadSchema>;

export const updateChannelMemberSchema = z.object({
  muted: z.boolean().optional(),
  role: z.enum(["member", "admin"]).optional(),
});
export type UpdateChannelMember = z.infer<typeof updateChannelMemberSchema>;

export const updateCompanyChannelsSchema = z.object({
  channelsEnabled: z.boolean(),
});
export type UpdateCompanyChannels = z.infer<typeof updateCompanyChannelsSchema>;
