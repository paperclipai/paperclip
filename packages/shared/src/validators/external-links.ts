import { z } from "zod";

export const EXTERNAL_LINK_PLATFORMS = ["jira", "linear", "github", "asana"] as const;

export const createExternalLinkSchema = z.object({
  platform: z.enum(EXTERNAL_LINK_PLATFORMS),
  externalKey: z.string().min(1),
  externalUrl: z.string().url(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateExternalLink = z.infer<typeof createExternalLinkSchema>;

export const lookupExternalLinkQuerySchema = z.object({
  platform: z.enum(EXTERNAL_LINK_PLATFORMS),
  externalKey: z.string().min(1),
});
