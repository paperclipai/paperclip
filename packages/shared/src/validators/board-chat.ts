import { z } from "zod";
import { multilineTextSchema } from "./text.js";

export const boardChatMessageSchema = z
  .object({
    companyId: z.string().min(1),
    message: multilineTextSchema.pipe(z.string().min(1).max(20000)),
    taskId: z.string().min(1).optional(),
  })
  .strict();

export type BoardChatMessage = z.infer<typeof boardChatMessageSchema>;

export const boardChatSilentResponseSchema = z
  .object({
    mode: z.literal("silent"),
    issueId: z.string(),
    commentId: z.string(),
    roomMessageId: z.string(),
  })
  .strict();

export const boardChatAdapterWakePendingResponseSchema = z
  .object({
    mode: z.literal("adapter_wake_pending"),
    issueId: z.string(),
    commentId: z.string(),
    roomMessageId: z.string(),
    mentionedAgentIds: z.array(z.string()),
  })
  .strict();

export const boardChatHostRunResponseSchema = z
  .object({
    mode: z.literal("host_run"),
    issueId: z.string(),
    commentId: z.string(),
    roomMessageId: z.string(),
    hostAgentId: z.string(),
    hostRunId: z.string(),
    status: z.string(),
  })
  .strict();

export const boardChatMessageResponseSchema = z.discriminatedUnion("mode", [
  boardChatSilentResponseSchema,
  boardChatAdapterWakePendingResponseSchema,
  boardChatHostRunResponseSchema,
]);

export type BoardChatMessageResponse = z.infer<typeof boardChatMessageResponseSchema>;
