import { z } from "zod";

export const executionWorkspaceStatusSchema = z.enum([
  "active",
  "idle",
  "in_review",
  "archived",
  "cleanup_failed",
]);

export const executionWorkspaceConfigSchema = z.object({
  provisionCommand: z.string().optional().nullable(),
  teardownCommand: z.string().optional().nullable(),
  cleanupCommand: z.string().optional().nullable(),
  workspaceRuntime: z.record(z.unknown()).optional().nullable(),
  desiredState: z.enum(["running", "stopped"]).optional().nullable(),
  serviceStates: z.record(z.enum(["running", "stopped"])).optional().nullable(),
}).strict();

export const workspaceRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
}).strict();

export const executionWorkspaceCloseReadinessStateSchema = z.enum([
  "ready",
  "ready_with_warnings",
  "blocked",
]);

export const executionWorkspaceCloseActionKindSchema = z.enum([
  "archive_record",
  "stop_runtime_services",
  "cleanup_command",
  "teardown_command",
  "git_worktree_remove",
  "git_branch_delete",
  "remove_local_directory",
]);

export const executionWorkspaceCloseActionSchema = z.object({
  kind: executionWorkspaceCloseActionKindSchema,
  label: z.string(),
  description: z.string(),
  command: z.string().nullable(),
}).strict();

export const executionWorkspaceCloseLinkedIssueSchema = z.object({
  id: z.string().uuid(),
  identifier: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  isTerminal: z.boolean(),
}).strict();

export const executionWorkspaceCloseGitReadinessSchema = z.object({
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

export const workspaceRuntimeServiceSchema = z.object({
  id: z.string(),
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  projectWorkspaceId: z.string().uuid().nullable(),
  executionWorkspaceId: z.string().uuid().nullable(),
  issueId: z.string().uuid().nullable(),
  scopeType: z.enum(["project_workspace", "execution_workspace", "run", "agent"]),
  scopeId: z.string().nullable(),
  serviceName: z.string(),
  status: z.enum(["starting", "running", "stopped", "failed"]),
  lifecycle: z.enum(["shared", "ephemeral"]),
  reuseKey: z.string().nullable(),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  port: z.number().int().nullable(),
  url: z.string().nullable(),
  provider: z.enum(["local_process", "adapter_managed"]),
  providerRef: z.string().nullable(),
  ownerAgentId: z.string().uuid().nullable(),
  startedByRunId: z.string().uuid().nullable(),
  lastUsedAt: z.coerce.date(),
  startedAt: z.coerce.date(),
  stoppedAt: z.coerce.date().nullable(),
  stopPolicy: z.record(z.unknown()).nullable(),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]),
  configIndex: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export const executionWorkspaceCloseReadinessSchema = z.object({
  workspaceId: z.string().uuid(),
  state: executionWorkspaceCloseReadinessStateSchema,
  blockingReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  linkedIssues: z.array(executionWorkspaceCloseLinkedIssueSchema),
  plannedActions: z.array(executionWorkspaceCloseActionSchema),
  isDestructiveCloseAllowed: z.boolean(),
  isSharedWorkspace: z.boolean(),
  isProjectPrimaryWorkspace: z.boolean(),
  git: executionWorkspaceCloseGitReadinessSchema.nullable(),
  runtimeServices: z.array(workspaceRuntimeServiceSchema),
}).strict();

export const updateExecutionWorkspaceSchema = z.object({
  name: z.string().min(1).optional(),
  cwd: z.string().optional().nullable(),
  repoUrl: z.string().optional().nullable(),
  baseRef: z.string().optional().nullable(),
  branchName: z.string().optional().nullable(),
  providerRef: z.string().optional().nullable(),
  status: executionWorkspaceStatusSchema.optional(),
  cleanupEligibleAt: z.string().datetime().optional().nullable(),
  cleanupReason: z.string().optional().nullable(),
  config: executionWorkspaceConfigSchema.optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
}).strict();

export type UpdateExecutionWorkspace = z.infer<typeof updateExecutionWorkspaceSchema>;
