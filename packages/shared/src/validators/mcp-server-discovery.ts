import { z } from "zod";

export const testMcpServerSchema = z.object({
  workspacePath: z.string().trim().min(1).nullable().optional(),
  timeoutSec: z.number().int().positive().nullable().optional(),
});

export type TestMcpServer = z.infer<typeof testMcpServerSchema>;
