import { z } from "zod";
import { ISSUE_STATUSES, ISSUE_PRIORITIES } from "../constants.js";

export const createJiraIntegrationSchema = z.object({
  name: z.string().min(1),
  hostUrl: z.string().url(),
  usernameOrEmail: z.string().min(1),
  apiToken: z.string().min(1),
});

export type CreateJiraIntegration = z.infer<typeof createJiraIntegrationSchema>;

export const updateJiraIntegrationSchema = z.object({
  name: z.string().min(1).optional(),
  hostUrl: z.string().url().optional(),
  usernameOrEmail: z.string().min(1).optional(),
  apiToken: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export type UpdateJiraIntegration = z.infer<typeof updateJiraIntegrationSchema>;

export const jiraImportSchema = z.object({
  integrationId: z.string().uuid(),
  projectKey: z.string().min(1),
  statuses: z.array(z.string().min(1)).min(1),
  assigneeAccountId: z.string().optional().nullable(),
  targetProjectId: z.string().uuid().optional().nullable(),
  targetStatus: z.enum(ISSUE_STATUSES).optional().default("backlog"),
  targetPriority: z.enum(ISSUE_PRIORITIES).optional(),
});

export type JiraImport = z.infer<typeof jiraImportSchema>;
