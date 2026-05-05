import { z } from "zod";

export const postAgentThreadMessageSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

export type PostAgentThreadMessage = z.infer<typeof postAgentThreadMessageSchema>;

export const markAgentThreadReadSchema = z.object({
  lastReadMessageId: z.string().uuid().optional().nullable(),
});

export type MarkAgentThreadRead = z.infer<typeof markAgentThreadReadSchema>;
