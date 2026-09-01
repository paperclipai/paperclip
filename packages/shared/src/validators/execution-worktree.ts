import { z } from "zod";
import {
  WORKSPACE_OVERVIEW_DEFAULT_LIMIT,
  WORKSPACE_OVERVIEW_MAX_LIMIT,
} from "../constants.js";

export const executionWorktreeStatusSchema = z.enum([
  "active",
  "idle",
  "in_review",
  "archived",
  "cleanup_failed",
]);

export const executionWorktreeDeliveryStateSchema = z.enum([
  "merged_via_pr",
  "merged_by_ancestry",
  "unmerged",
  "unknown",
]);

const worktreeOverviewStatusFilterSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  const rawValues = Array.isArray(value) ? value : [value];
  const statuses = rawValues.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    return entry.split(",").map((part) => part.trim()).filter(Boolean);
  });
  return statuses.length > 0 ? statuses : undefined;
}, z.array(executionWorktreeStatusSchema).optional());

export const worktreeOverviewQuerySchema = z.object({
  projectId: z.string().guid().optional(),
  status: worktreeOverviewStatusFilterSchema,
  limit: z.coerce.number().int().min(1).max(WORKSPACE_OVERVIEW_MAX_LIMIT).optional().default(WORKSPACE_OVERVIEW_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
}).strict();

export const executionWorktreeConfigSchema = z.object({
  environmentId: z.string().guid().optional().nullable(),
  provisionCommand: z.string().optional().nullable(),
  runtimeProvisionCommand: z.string().optional().nullable(),
  teardownCommand: z.string().optional().nullable(),
  cleanupCommand: z.string().optional().nullable(),
  workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
  desiredState: z.enum(["running", "stopped", "manual"]).optional().nullable(),
  serviceStates: z.record(z.string(), z.enum(["running", "stopped", "manual"])).optional().nullable(),
}).strict();

export const worktreeRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().guid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
}).strict();

export const executionWorktreeCloseReadinessStateSchema = z.enum([
  "ready",
  "ready_with_warnings",
  "blocked",
]);

export const executionWorktreeCloseActionKindSchema = z.enum([
  "archive_record",
  "stop_runtime_services",
  "cleanup_command",
  "teardown_command",
  "git_worktree_remove",
  "git_branch_delete",
  "remove_local_directory",
]);

export const executionWorktreeCloseActionSchema = z.object({
  kind: executionWorktreeCloseActionKindSchema,
  label: z.string(),
  description: z.string(),
  command: z.string().nullable(),
}).strict();

export const executionWorktreeCloseLinkedIssueSchema = z.object({
  id: z.string().guid(),
  identifier: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  isTerminal: z.boolean(),
}).strict();

export const executionWorktreeCloseGitReadinessSchema = z.object({
  repoRoot: z.string().nullable(),
  workspacePath: z.string().nullable(),
  branchName: z.string().nullable(),
  baseRef: z.string().nullable(),
  hasDirtyTrackedFiles: z.boolean(),
  hasUntrackedFiles: z.boolean(),
  dirtyEntryCount: z.number().int().nonnegative(),
  untrackedEntryCount: z.number().int().nonnegative(),
  aheadCount: z.number().int().nonnegative().nullable(),
  behindCount: z.number().int().nonnegative().nullable(),
  isMergedIntoBase: z.boolean().nullable(),
  createdByRuntime: z.boolean(),
}).strict();

export const worktreeRuntimeServiceSchema = z.object({
  id: z.string(),
  companyId: z.string().guid(),
  projectId: z.string().guid().nullable(),
  projectWorkspaceId: z.string().guid().nullable(),
  executionWorkspaceId: z.string().guid().nullable(),
  issueId: z.string().guid().nullable(),
  scopeType: z.enum(["project_workspace", "execution_workspace", "run", "agent"]),
  scopeId: z.string().nullable(),
  serviceName: z.string(),
  status: z.enum(["provisioning", "starting", "running", "stopped", "failed"]),
  lifecycle: z.enum(["shared", "ephemeral"]),
  reuseKey: z.string().nullable(),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  port: z.number().int().nullable(),
  url: z.string().nullable(),
  provider: z.enum(["local_process", "adapter_managed"]),
  providerRef: z.string().nullable(),
  ownerAgentId: z.string().guid().nullable(),
  startedByRunId: z.string().guid().nullable(),
  lastUsedAt: z.coerce.date(),
  startedAt: z.coerce.date(),
  stoppedAt: z.coerce.date().nullable(),
  stopPolicy: z.record(z.string(), z.unknown()).nullable(),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]),
  configIndex: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export const executionWorktreeCloseReadinessSchema = z.object({
  workspaceId: z.string().guid(),
  deliveryState: executionWorktreeDeliveryStateSchema,
  state: executionWorktreeCloseReadinessStateSchema,
  blockingReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  linkedIssues: z.array(executionWorktreeCloseLinkedIssueSchema),
  plannedActions: z.array(executionWorktreeCloseActionSchema),
  isDestructiveCloseAllowed: z.boolean(),
  isSharedWorkspace: z.boolean(),
  isProjectPrimaryWorkspace: z.boolean(),
  git: executionWorktreeCloseGitReadinessSchema.nullable(),
  runtimeServices: z.array(worktreeRuntimeServiceSchema),
}).strict();

export const updateExecutionWorktreeSchema = z.object({
  name: z.string().min(1).optional(),
  cwd: z.string().optional().nullable(),
  repoUrl: z.string().optional().nullable(),
  baseRef: z.string().optional().nullable(),
  branchName: z.string().optional().nullable(),
  providerRef: z.string().optional().nullable(),
  status: executionWorktreeStatusSchema.optional(),
  cleanupEligibleAt: z.string().datetime().optional().nullable(),
  cleanupReason: z.string().optional().nullable(),
  config: executionWorktreeConfigSchema.optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();

const branchReconcileReasonSchema = z.string().trim().min(1);

export const reconcileExecutionWorktreeBranchSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("forward"),
    reason: branchReconcileReasonSchema.optional().nullable(),
  }).strict(),
  z.object({
    mode: z.literal("override"),
    reason: branchReconcileReasonSchema,
  }).strict(),
  z.object({
    mode: z.literal("quarantine_restore"),
    reason: branchReconcileReasonSchema.optional().nullable(),
  }).strict(),
]);

export type UpdateExecutionWorktree = z.infer<typeof updateExecutionWorktreeSchema>;
export type ReconcileExecutionWorktreeBranch = z.infer<typeof reconcileExecutionWorktreeBranchSchema>;
export type WorktreeOverviewQuery = z.infer<typeof worktreeOverviewQuerySchema>;
