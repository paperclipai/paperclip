import { z } from "zod";

export const chatMessageRoleSchema = z.enum(["user", "assistant"]);

export const addChatMessageSchema = z.object({
  content: z.string().trim().min(1),
});

export const createChatSessionSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export const updateChatSessionSchema = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  archived: z.boolean().optional(),
});

export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;
export type AddChatMessage = z.infer<typeof addChatMessageSchema>;
export type CreateChatSession = z.infer<typeof createChatSessionSchema>;
export type UpdateChatSession = z.infer<typeof updateChatSessionSchema>;
