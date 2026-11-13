import { z } from "zod";
import { maxStringLength } from "./text.js";

/** Same ceiling as an ordinary issue document; brevity is guidance, not a quota. */
export const AGENT_COMMENTARY_MAX_LENGTH = 524_288;
export const AGENT_COMMENTARY_KINDS = ["complaint", "suggestion"] as const;

export const agentCommentaryToolInputSchema = z.object({
  // The ceiling is JavaScript string length, matching submit-agent-commentary.mjs.
  body: maxStringLength(z.string(), AGENT_COMMENTARY_MAX_LENGTH).refine((body) => body.trim().length > 0, "Feedback must not be empty"),
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

export const AGENT_COMMENTARY_SORTS = ["newest", "votes"] as const;
export type AgentCommentarySort = typeof AGENT_COMMENTARY_SORTS[number];

export const agentCommentaryQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  kind: z.enum(AGENT_COMMENTARY_KINDS).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(AGENT_COMMENTARY_SORTS).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type AgentCommentaryQuery = z.infer<typeof agentCommentaryQuerySchema>;
export interface AgentCommentaryEntry {
  id: string;
  kind: AgentCommentaryKind;
  preview: string;
  createdAt: string;
  agent: { id: string; name: string; icon: string | null };
  runId: string;
  task: { id: string; identifier: string | null; title: string } | null;
  voteCount: number;
  votedByMe: boolean;
}
export interface AgentCommentaryDetail extends AgentCommentaryEntry {
  body: string;
}
export interface AgentCommentaryPage {
  items: AgentCommentaryEntry[];
  total: number;
  limit: number;
  offset: number;
}
export interface AgentCommentaryVoteState {
  id: string;
  voteCount: number;
  votedByMe: boolean;
}
