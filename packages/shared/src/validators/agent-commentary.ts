import { z } from "zod";

/** Same ceiling as an ordinary issue document; brevity is guidance, not a quota. */
export const AGENT_COMMENTARY_MAX_LENGTH = 524_288;
export const AGENT_COMMENTARY_KINDS = ["complaint", "suggestion"] as const;

export const agentCommentaryToolInputSchema = z.object({
  body: z.string().max(AGENT_COMMENTARY_MAX_LENGTH).refine((body) => body.trim().length > 0, "Feedback must not be empty"),
  idempotencyKey: z.string().trim().min(1).max(240),
}).strict();

export const submitAgentCommentarySchema = agentCommentaryToolInputSchema.extend({
  kind: z.enum(AGENT_COMMENTARY_KINDS),
}).strict();

export type AgentCommentaryKind = typeof AGENT_COMMENTARY_KINDS[number];
export type SubmitAgentCommentary = z.infer<typeof submitAgentCommentarySchema>;
export type AgentCommentaryAcknowledgement = {
  id: string;
  kind: AgentCommentaryKind;
  createdAt: string;
  replayed: boolean;
};
