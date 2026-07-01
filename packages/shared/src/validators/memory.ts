import { z } from "zod";
import { multilineTextSchema } from "./text.js";

export const memoryEntrySourceSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  id: z.string().trim().min(1).max(255),
}).strict();

export const ingestMemorySchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  key: z.string().trim().min(1).max(64),
  title: z.string().trim().max(240).optional().nullable(),
  body: multilineTextSchema.pipe(z.string().min(1).max(524288)),
  tags: z.array(z.string().trim().min(1).max(48)).max(20).optional(),
  source: memoryEntrySourceSchema.optional().nullable(),
}).strict();

export type IngestMemory = z.infer<typeof ingestMemorySchema>;

export const searchMemorySchema = z.object({
  query: z.string().trim().max(500).optional(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  key: z.string().trim().min(1).max(64).optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(20).optional(),
  limit: z.number().int().positive().max(200).optional().default(50),
}).strict();

export type SearchMemory = z.infer<typeof searchMemorySchema>;
