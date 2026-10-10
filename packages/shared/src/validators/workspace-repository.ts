import { z } from "zod";

export const prepareWorkspaceRepositorySchema = z.object({
  repository: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("catalog"), id: z.string().min(1).max(255) }).strict(),
    z.object({ kind: z.literal("url"), url: z.string().url().max(2048) }).strict(),
  ]),
  // A revision is data passed as one argv entry, never a shell expression.
  ref: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/).refine(value => !value.includes("..") && !value.includes("//"), "Invalid Git ref").optional(),
  requestKey: z.string().min(1).max(240),
}).strict();
export type PrepareWorkspaceRepository = z.infer<typeof prepareWorkspaceRepositorySchema>;
