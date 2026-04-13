import { z } from "zod";

export const upsertClientInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
});

export type UpsertClientInstructionsFile = z.infer<typeof upsertClientInstructionsFileSchema>;
