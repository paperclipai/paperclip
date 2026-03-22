import { z } from "zod";

export const createChatThreadSchema = z.object({
  issueId: z.string().uuid().optional().nullable(),
  title: z.string().max(256).optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});
export type CreateChatThread = z.infer<typeof createChatThreadSchema>;

export const updateChatThreadSchema = z.object({
  title: z.string().max(256).optional().nullable(),
  status: z.enum(["open", "closed"]).optional(),
  issueId: z.string().uuid().optional().nullable(),
});
export type UpdateChatThread = z.infer<typeof updateChatThreadSchema>;

export const createChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  body: z.string().min(1).max(32000),
  metadata: z.record(z.unknown()).optional().nullable(),
});
export type CreateChatMessage = z.infer<typeof createChatMessageSchema>;
