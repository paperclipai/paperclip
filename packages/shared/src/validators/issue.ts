import { z } from "zod";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "../constants.js";

export const issueAssigneeAdapterOverridesSchema = z
  .object({
    adapterConfig: z.record(z.unknown()).optional(),
    useProjectWorkspace: z.boolean().optional(),
  })
  .strict();

export const createIssueSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  approvalId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(ISSUE_STATUSES).optional().default("backlog"),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  requestDepth: z.number().int().nonnegative().optional().default(0),
  billingCode: z.string().optional().nullable(),
  assigneeAdapterOverrides: issueAssigneeAdapterOverridesSchema.optional().nullable(),
  labelIds: z.array(z.string().uuid()).optional(),
});

export type CreateIssue = z.infer<typeof createIssueSchema>;

export const createIssueLabelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
});

export type CreateIssueLabel = z.infer<typeof createIssueLabelSchema>;

export const issueReviewSubmissionSchema = z.object({
  checkoutId: z.string().uuid().optional().nullable(),
  branchName: z.string().trim().min(1),
  headCommitSha: z.string().trim().min(1),
  remoteBranchName: z.string().trim().min(1).optional().nullable(),
  pullRequestUrl: z.string().trim().url(),
  pullRequestNumber: z.number().int().positive().optional().nullable(),
  pullRequestTitle: z.string().trim().min(1).optional().nullable(),
});

export const issuePageSortFieldSchema = z.enum(["updated", "created", "priority", "title", "status"]);
export const issuePageSortDirectionSchema = z.enum(["asc", "desc"]);

function parseOptionalPositiveInteger(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

function parseTerminalAgeHours(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    if (trimmed === "all") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (typeof value === "number") return value;
  return value;
}

// Keep the paginated issue query contract explicit so the top-level /issues page can evolve
// without changing the long-lived array response used by other issue consumers.
export const listIssuesPageQuerySchema = z.object({
  status: z.string().trim().min(1).optional(),
  assigneeAgentId: z.string().trim().min(1).optional(),
  assigneeUserId: z.string().trim().min(1).optional(),
  touchedByUserId: z.string().trim().min(1).optional(),
  unreadForUserId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  parentId: z.string().trim().min(1).optional(),
  labelId: z.string().trim().min(1).optional(),
  q: z.string().trim().optional(),
  page: z.preprocess(parseOptionalPositiveInteger, z.number().int().min(1).default(1)),
  pageSize: z.preprocess(parseOptionalPositiveInteger, z.number().int().min(1).max(100).default(50)),
  sortField: issuePageSortFieldSchema.optional(),
  sortDir: issuePageSortDirectionSchema.optional(),
  terminalAgeHours: z.preprocess(parseTerminalAgeHours, z.number().int().positive().nullable().default(48)),
});

export const updateIssueSchema = createIssueSchema.partial().extend({
  comment: z.string().min(1).optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
  reviewSubmission: issueReviewSubmissionSchema.optional(),
});

export type UpdateIssue = z.infer<typeof updateIssueSchema>;
export type ListIssuesPageQuery = z.infer<typeof listIssuesPageQuerySchema>;

export const checkoutIssueSchema = z.object({
  agentId: z.string().uuid(),
  expectedStatuses: z.array(z.enum(ISSUE_STATUSES)).nonempty(),
});

export type CheckoutIssue = z.infer<typeof checkoutIssueSchema>;

export const addIssueCommentSchema = z.object({
  body: z.string().min(1),
  reopen: z.boolean().optional(),
  interrupt: z.boolean().optional(),
});

export type AddIssueComment = z.infer<typeof addIssueCommentSchema>;

export const linkIssueApprovalSchema = z.object({
  approvalId: z.string().uuid(),
});

export type LinkIssueApproval = z.infer<typeof linkIssueApprovalSchema>;

export const createIssueAttachmentMetadataSchema = z.object({
  issueCommentId: z.string().uuid().optional().nullable(),
});

export type CreateIssueAttachmentMetadata = z.infer<typeof createIssueAttachmentMetadataSchema>;
