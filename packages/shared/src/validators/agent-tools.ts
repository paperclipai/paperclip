import { z } from "zod";

export const executeMergedAgentToolSchema = z.object({
  name: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
  projectId: z.string().uuid().nullable().optional(),
});

export type ExecuteMergedAgentTool = z.infer<typeof executeMergedAgentToolSchema>;
