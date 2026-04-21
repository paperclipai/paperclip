import { z } from "zod";

export const upsertAgentMemorySchema = z.object({
  agentId: z.string().uuid().optional().nullable(),
  namespace: z.string().min(1).max(255),
  key: z.string().min(1).max(255),
  value: z.record(z.unknown()),
});

export type UpsertAgentMemory = z.infer<typeof upsertAgentMemorySchema>;

export const deleteAgentMemorySchema = z.object({
  namespace: z.string().min(1).max(255),
  key: z.string().min(1).max(255),
});

export type DeleteAgentMemory = z.infer<typeof deleteAgentMemorySchema>;
