import { z } from "zod";

export const upsertTelegramConfigSchema = z.object({
  botToken: z.string().trim().min(10, "Bot token is required"),
  enabled: z.boolean().optional().default(false),
  allowedUserIds: z.array(z.string().trim().min(1)).optional().default([]),
});

export const updateTelegramConfigSchema = z.object({
  botToken: z.string().trim().min(10).optional(),
  enabled: z.boolean().optional(),
  ownerChatId: z.string().trim().min(1).optional().nullable(),
  allowedUserIds: z.array(z.string().trim().min(1)).optional(),
});

export const telegramMediaTypeSchema = z.enum(["photo", "document"]);

export const sendTelegramMessageSchema = z
  .object({
    text: z.string().trim().optional(),
    sessionId: z.string().uuid().optional(),
    mediaType: telegramMediaTypeSchema.optional(),
    mediaUrl: z.string().url().optional(),
    mediaPath: z.string().trim().min(1).optional(),
    caption: z.string().trim().max(1024).optional(),
  })
  .refine(
    (data) => {
      // Must have text OR (mediaType with a source)
      const hasText = !!data.text;
      const hasMedia = !!data.mediaType && (!!data.mediaUrl || !!data.mediaPath);
      return hasText || hasMedia;
    },
    { message: "Either text or mediaType with mediaUrl/mediaPath is required" },
  );

export type UpsertTelegramConfig = z.infer<typeof upsertTelegramConfigSchema>;
export type UpdateTelegramConfig = z.infer<typeof updateTelegramConfigSchema>;
export type SendTelegramMessage = z.infer<typeof sendTelegramMessageSchema>;
