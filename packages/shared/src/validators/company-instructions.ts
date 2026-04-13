import { z } from "zod";

export const upsertCompanyInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
});

export type UpsertCompanyInstructionsFile = z.infer<typeof upsertCompanyInstructionsFileSchema>;
