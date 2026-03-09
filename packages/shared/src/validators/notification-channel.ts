import { z } from "zod";
import { NOTIFICATION_CHANNEL_TYPES, NOTIFICATION_EVENT_TYPES } from "../constants.js";

export const createNotificationChannelSchema = z.object({
  channelType: z.enum(NOTIFICATION_CHANNEL_TYPES),
  name: z.string().min(1).max(100),
  config: z.record(z.unknown()),
  eventFilter: z.array(z.enum(NOTIFICATION_EVENT_TYPES)).optional().default([]),
  enabled: z.boolean().optional().default(true),
});

export const updateNotificationChannelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  config: z.record(z.unknown()).optional(),
  eventFilter: z.array(z.enum(NOTIFICATION_EVENT_TYPES)).optional(),
  enabled: z.boolean().optional(),
});

export const testNotificationChannelConfigSchema = z.object({
  channelType: z.enum(NOTIFICATION_CHANNEL_TYPES),
  config: z.record(z.unknown()),
});

export type CreateNotificationChannel = z.infer<typeof createNotificationChannelSchema>;
export type UpdateNotificationChannel = z.infer<typeof updateNotificationChannelSchema>;
export type TestNotificationChannelConfig = z.infer<typeof testNotificationChannelConfigSchema>;
