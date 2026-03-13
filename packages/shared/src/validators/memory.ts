import { z } from "zod";
import { MEMORY_SCOPE_TYPES, MEMORY_CATEGORIES } from "../constants.js";

export const createMemorySchema = z.object({
  content: z.string().min(1).max(4000),
  scopeType: z.enum(MEMORY_SCOPE_TYPES).optional().default("company"),
  scopeId: z.string().uuid().optional().nullable(),
  category: z.enum(MEMORY_CATEGORIES).optional().default("knowledge"),
  confidence: z.number().min(0).max(1).optional().default(0.9),
});

export type CreateMemory = z.infer<typeof createMemorySchema>;

export const queryMemoriesSchema = z.object({
  scopeType: z.enum(MEMORY_SCOPE_TYPES).optional(),
  scopeId: z.string().uuid().optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export type QueryMemories = z.infer<typeof queryMemoriesSchema>;
