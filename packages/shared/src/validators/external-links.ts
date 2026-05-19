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

// Structured externalRefs field used on issue create/update/read payloads.
// Each platform entry is optional and nullable (null = remove the link).
export const issueExternalRefsJiraSchema = z.object({
  key: z.string().min(1),
  externalUrl: z.string().url(),
  projectKey: z.string().optional().nullable(),
  instanceUrl: z.string().url().optional().nullable(),
});

export type IssueExternalRefsJira = z.infer<typeof issueExternalRefsJiraSchema>;

export const issueExternalRefsSchema = z.object({
  jira: issueExternalRefsJiraSchema.nullable().optional(),
}).optional().nullable();

export type IssueExternalRefs = z.infer<typeof issueExternalRefsSchema>;
