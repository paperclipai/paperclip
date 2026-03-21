import { z } from "zod";

export const SPARRING_SESSION_STATUSES = ["active", "completed", "aborted", "timed_out"] as const;
export const SPARRING_PARTICIPANT_STATUSES = ["invited", "active", "completed", "timed_out", "error"] as const;
export const SPARRING_TURN_ROLES = ["coordinator", "participant"] as const;

export const sparringSessionConfigSchema = z.object({
  maxRounds: z.number().int().min(1).max(50).optional().default(5),
  totalTimeoutSec: z.number().int().min(60).max(3600).optional().default(600),
  turnTimeoutSec: z.number().int().min(10).max(300).optional().default(120),
});

export const createSparringSessionSchema = z.object({
  topic: z.string().min(1).max(2000),
  participantAgentId: z.string().uuid(),
  participantRole: z.string().max(100).optional(),
  config: sparringSessionConfigSchema.optional(),
});

export const recordSparringTurnSchema = z.object({
  agentId: z.string().uuid(),
  roundNumber: z.number().int().min(1),
  turnNumber: z.number().int().min(1),
  role: z.enum(SPARRING_TURN_ROLES),
  content: z.string().min(1),
  tokenCount: z.number().int().min(0).optional(),
  durationMs: z.number().int().min(0).optional(),
});

export const completeSparringSessionSchema = z.object({
  summary: z.string().min(1).max(10000),
});

export const abortSparringSessionSchema = z.object({
  reason: z.string().max(1000).optional(),
});

export type CreateSparringSession = z.infer<typeof createSparringSessionSchema>;
export type RecordSparringTurn = z.infer<typeof recordSparringTurnSchema>;
export type CompleteSparringSession = z.infer<typeof completeSparringSessionSchema>;
export type AbortSparringSession = z.infer<typeof abortSparringSessionSchema>;
export type SparringSessionConfig = z.infer<typeof sparringSessionConfigSchema>;
