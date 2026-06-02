import { z } from "zod";

export const CHANNEL_PLATFORMS = ["slack", "discord", "telegram", "email", "webhook"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export const CHANNEL_STATUSES = ["active", "disconnected", "error"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const CHANNEL_DIRECTIONS = ["outbound", "inbound", "bidirectional"] as const;
export type ChannelDirection = (typeof CHANNEL_DIRECTIONS)[number];

export const CHANNEL_MESSAGE_STATUSES = ["pending", "delivered", "failed", "received"] as const;
export type ChannelMessageStatus = (typeof CHANNEL_MESSAGE_STATUSES)[number];

export const CHANNEL_MESSAGE_DIRECTIONS = ["outbound", "inbound"] as const;
export type ChannelMessageDirection = (typeof CHANNEL_MESSAGE_DIRECTIONS)[number];

export const createChannelSchema = z.object({
  platform: z.enum(CHANNEL_PLATFORMS),
  name: z.string().trim().min(1).max(200),
  config: z.record(z.unknown()).optional().default({}),
  status: z.enum(CHANNEL_STATUSES).optional().default("active"),
  direction: z.enum(CHANNEL_DIRECTIONS).optional().default("outbound"),
});
export type CreateChannel = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = createChannelSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Update body must contain at least one field",
  });
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

export const createChannelRouteSchema = z.object({
  channelId: z.string().uuid(),
  trigger: z.string().trim().min(1).max(200),
  filter: z.record(z.unknown()).optional().nullable(),
  template: z.string().optional().nullable(),
  enabled: z.boolean().optional().default(true),
});
export type CreateChannelRoute = z.infer<typeof createChannelRouteSchema>;

export const updateChannelRouteSchema = createChannelRouteSchema
  .partial()
  .omit({ channelId: true })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Update body must contain at least one field",
  });
export type UpdateChannelRoute = z.infer<typeof updateChannelRouteSchema>;

export const listChannelMessagesQuerySchema = z.object({
  channelId: z.string().uuid().optional(),
  direction: z.enum(CHANNEL_MESSAGE_DIRECTIONS).optional(),
  status: z.enum(CHANNEL_MESSAGE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
export type ListChannelMessagesQuery = z.infer<typeof listChannelMessagesQuerySchema>;

export interface Channel {
  id: string;
  companyId: string;
  platform: ChannelPlatform;
  name: string;
  config: Record<string, unknown>;
  status: ChannelStatus;
  direction: ChannelDirection;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelRoute {
  id: string;
  companyId: string;
  channelId: string;
  trigger: string;
  filter: Record<string, unknown> | null;
  template: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface ChannelMessage {
  id: string;
  companyId: string;
  channelId: string;
  direction: ChannelMessageDirection;
  content: string;
  metadata: Record<string, unknown>;
  issueId: string | null;
  agentId: string | null;
  status: ChannelMessageStatus;
  createdAt: string;
}
