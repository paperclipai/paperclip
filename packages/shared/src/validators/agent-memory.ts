import { z } from "zod";
import { AGENT_MEMORY_TYPES } from "../constants.js";

const tagsArraySchema = z.array(z.string().trim().min(1).max(60)).max(30);

/** Board or agent writes a new memory. */
export const createAgentMemorySchema = z.object({
  type: z.enum(AGENT_MEMORY_TYPES).optional().default("semantic"),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  tags: tagsArraySchema.optional().default([]),
  confidence: z.number().int().min(0).max(100).optional().default(0),
  sourceRunId: z.string().uuid().optional().nullable(),
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceCommentId: z.string().uuid().optional().nullable(),
});

export type CreateAgentMemory = z.infer<typeof createAgentMemorySchema>;

/** Query parameters for recall. */
export const recallAgentMemorySchema = z.object({
  type: z.enum(AGENT_MEMORY_TYPES).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  query: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type RecallAgentMemory = z.infer<typeof recallAgentMemorySchema>;

/**
 * Correct a memory: write a replacement and supersede the old one.
 * Omitted `tags`/`confidence` stay undefined so the service preserves the
 * existing memory's values instead of overwriting them with defaults.
 */
export const correctAgentMemorySchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  tags: tagsArraySchema.optional(),
  confidence: z.number().int().min(0).max(100).optional(),
});

export type CorrectAgentMemory = z.infer<typeof correctAgentMemorySchema>;
