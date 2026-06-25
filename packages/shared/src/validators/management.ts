import { z } from "zod";
import { HEARTBEAT_RUN_STATUSES, ISSUE_PRIORITIES, ISSUE_STATUSES } from "../constants.js";

export const managementIssueListQuerySchema = z.object({
  status: z.enum(ISSUE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type ManagementIssueListQuery = z.infer<typeof managementIssueListQuerySchema>;

export const managementRunListQuerySchema = z.object({
  status: z.enum(HEARTBEAT_RUN_STATUSES).optional(),
  activeOnly: z.coerce.boolean().optional().default(true),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type ManagementRunListQuery = z.infer<typeof managementRunListQuerySchema>;

export const managementAnalyzerSnapshotQuerySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(24 * 14).optional().default(24),
  evidenceLimit: z.coerce.number().int().min(1).max(25).optional().default(10),
});

export type ManagementAnalyzerSnapshotQuery = z.infer<typeof managementAnalyzerSnapshotQuerySchema>;

/**
 * Body for the audited cross-organization delegation endpoint
 * (`POST /api/management/companies/:companyId/delegated-issues`). Deliberately
 * narrow: a delegating actor may only create a single bounded issue in the
 * target company and (optionally) target a specific assignee in that company.
 * It cannot edit existing target-company issues, instructions, or config.
 */
export const managementDelegatedIssueCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  // When omitted, the target company's CEO agent is used as the assignee.
  assigneeAgentId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
});

export type ManagementDelegatedIssueCreate = z.infer<typeof managementDelegatedIssueCreateSchema>;
