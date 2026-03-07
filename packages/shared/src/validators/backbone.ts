import { z } from "zod";
import {
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_CATEGORIES,
  MESSAGE_TYPES,
  MESSAGE_PRIORITIES,
  PROPOSAL_TYPES,
  QUORUM_TYPES,
  VOTE_VALUES,
} from "../constants.js";

// ── Agent Memory ───────────────────────────────────────────────────────

export const setMemorySchema = z.object({
  key: z.string().min(1).max(512),
  value: z.string().max(65536).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  ttlSeconds: z.number().int().positive().nullable().optional(),
});
export type SetMemory = z.infer<typeof setMemorySchema>;

// ── Knowledge Base ─────────────────────────────────────────────────────

export const createKnowledgeEntrySchema = z.object({
  category: z.enum(KNOWLEDGE_CATEGORIES).optional(),
  title: z.string().min(1).max(512),
  content: z.string().min(1).max(131072),
  metadata: z.record(z.unknown()).optional(),
  status: z.enum(KNOWLEDGE_STATUSES).optional(),
});
export type CreateKnowledgeEntry = z.infer<typeof createKnowledgeEntrySchema>;

export const updateKnowledgeEntrySchema = z.object({
  category: z.enum(KNOWLEDGE_CATEGORIES).optional(),
  title: z.string().min(1).max(512).optional(),
  content: z.string().min(1).max(131072).optional(),
  metadata: z.record(z.unknown()).optional(),
  status: z.enum(KNOWLEDGE_STATUSES).optional(),
});
export type UpdateKnowledgeEntry = z.infer<typeof updateKnowledgeEntrySchema>;

// ── Agent Messages ─────────────────────────────────────────────────────

export const sendMessageSchema = z.object({
  channel: z.string().min(1).max(128).nullable().optional(),
  toAgentId: z.string().uuid().nullable().optional(),
  messageType: z.enum(MESSAGE_TYPES).optional(),
  subject: z.string().max(512).nullable().optional(),
  body: z.string().min(1).max(131072),
  payload: z.record(z.unknown()).optional(),
  parentMessageId: z.string().uuid().nullable().optional(),
  referenceType: z.string().max(64).nullable().optional(),
  referenceId: z.string().uuid().nullable().optional(),
  priority: z.enum(MESSAGE_PRIORITIES).optional(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

export const acknowledgeMessageSchema = z.object({
  messageId: z.string().uuid(),
});
export type AcknowledgeMessage = z.infer<typeof acknowledgeMessageSchema>;

// ── Consensus ──────────────────────────────────────────────────────────

export const createProposalSchema = z.object({
  title: z.string().min(1).max(512),
  description: z.string().min(1).max(131072),
  proposalType: z.enum(PROPOSAL_TYPES).optional(),
  quorumType: z.enum(QUORUM_TYPES).optional(),
  quorumMinVotes: z.number().int().min(0).optional(),
  payload: z.record(z.unknown()).optional(),
  knowledgeEntryId: z.string().uuid().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type CreateProposal = z.infer<typeof createProposalSchema>;

export const castVoteSchema = z.object({
  vote: z.enum(VOTE_VALUES),
  reasoning: z.string().max(4096).nullable().optional(),
});
export type CastVote = z.infer<typeof castVoteSchema>;
