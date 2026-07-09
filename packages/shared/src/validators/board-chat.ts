import { z } from "zod";
import { HEARTBEAT_RUN_STATUSES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const boardChatMessageSchema = z
  .object({
    companyId: z.string().min(1),
    message: multilineTextSchema.pipe(z.string().min(1).max(20000)),
    taskId: z.string().min(1).optional(),
    clientMessageId: z.string().min(1).max(128).optional(),
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

/**
 * @deprecated Replaced by `host_run` responses from the route layer. Kept for backward compatibility.
 */
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
    status: z.enum(HEARTBEAT_RUN_STATUSES),
  })
  .strict();

export const boardChatFanoutHostRunSchema = z
  .object({
    agentId: z.string(),
    runId: z.string(),
  })
  .strict();

export const boardChatFanoutResponseSchema = z
  .object({
    mode: z.literal("fanout"),
    issueId: z.string(),
    commentId: z.string(),
    roomMessageId: z.string(),
    hostRuns: z.array(boardChatFanoutHostRunSchema).min(2),
    delegationStatus: z.literal("pending"),
  })
  .strict();

export const boardChatMessageResponseSchema = z.discriminatedUnion("mode", [
  boardChatSilentResponseSchema,
  boardChatAdapterWakePendingResponseSchema,
  boardChatHostRunResponseSchema,
  boardChatFanoutResponseSchema,
]);

export type BoardChatMessageResponse = z.infer<typeof boardChatMessageResponseSchema>;

export const BOARD_CHAT_TURN_STATUSES = [
  "silent",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "unknown",
] as const;

export type BoardChatTurnStatus = (typeof BOARD_CHAT_TURN_STATUSES)[number];

export const boardChatTurnStatusQuerySchema = z
  .object({
    companyId: z.string().min(1),
  })
  .strict();

export const boardChatTurnStatusSchema = z
  .object({
    roomMessageId: z.string(),
    issueId: z.string(),
    commentId: z.string(),
    hostRunId: z.string().optional(),
    hostAgentId: z.string().optional(),
    status: z.enum(BOARD_CHAT_TURN_STATUSES),
    costUsd: z.number().optional(),
  })
  .strict();

export type BoardChatTurnStatusResponse = z.infer<typeof boardChatTurnStatusSchema>;
