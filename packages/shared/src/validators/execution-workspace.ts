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
  "pull_request_push",
  "pull_request_open",
  "pull_request_merge",
]);

export const pullRequestMergeStrategySchema = z.enum(["merge", "squash", "rebase"]);

export const pullRequestRecordStatusSchema = z.enum([
  "requested",
  "opened",
  "merged",
  "failed",
  "skipped",
]);

export const pullRequestRequestModeSchema = z.enum(["fire_and_forget", "blocking"]);

const KNOWN_PULL_REQUEST_POLICY_KEYS = new Set([
  "autoOpen",
  "autoMerge",
  "mergeStrategy",
  "targetBranch",
  "titleTemplate",
  "bodyTemplate",
  "draft",
  "requireResultBeforeArchive",
  "archiveTimeoutMs",
  "extensions",
]);

const pullRequestPolicyStrictSchema = z.object({
  autoOpen: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
  mergeStrategy: pullRequestMergeStrategySchema.optional(),
  targetBranch: z.string().min(1).optional(),
  titleTemplate: z.string().optional(),
  bodyTemplate: z.string().optional(),
  draft: z.boolean().optional(),
  requireResultBeforeArchive: z.boolean().optional(),
  archiveTimeoutMs: z.number().int().positive().optional(),
  extensions: z.record(z.unknown()).optional(),
}).strict();

/**
 * Strict-at-the-known-keys but forward-compatible at the top level.
 *
 * The design contract (docs/31-upstream-paperclip-pull-request-policy.md
 * §1) guarantees that unknown top-level keys on `pullRequestPolicy`
 * survive a round-trip through the parser by being moved onto
 * `policy.extensions`. To honor that contract at the API boundary —
 * where zod runs before the server-side parser — we preprocess the
 * input: known keys are kept in place, everything else is merged
 * into `extensions`. The downstream strict schema then validates
 * that known keys have the right types without tripping on the
 * unknowns.
 *
 * This keeps vendor-specific additions (e.g. a consumer carrying
 * `gitlabApprovalRule` on its policy) working even when the server
 * hasn't upgraded to understand them yet.
 */
export const pullRequestPolicySchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  const known: Record<string, unknown> = {};
  const unknowns: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "extensions") continue;
    if (KNOWN_PULL_REQUEST_POLICY_KEYS.has(key)) {
      known[key] = value;
    } else {
      unknowns[key] = value;
    }
  }
  const existingExt =
    input.extensions && typeof input.extensions === "object" && !Array.isArray(input.extensions)
      ? (input.extensions as Record<string, unknown>)
      : {};
  const mergedExtensions = { ...existingExt, ...unknowns };
  if (Object.keys(mergedExtensions).length > 0) {
    known.extensions = mergedExtensions;
  }
  return known;
}, pullRequestPolicyStrictSchema);

export const executionWorkspacePullRequestRecordSchema = z.object({
  status: pullRequestRecordStatusSchema,
  mode: pullRequestRequestModeSchema,
  url: z.string().optional().nullable(),
  number: z.number().int().optional().nullable(),
  sha: z.string().optional().nullable(),
  mergedAt: z.string().optional().nullable(),
  requestedAt: z.string().optional().nullable(),
  resolvedAt: z.string().optional().nullable(),
  error: z.string().optional().nullable(),
  policy: pullRequestPolicySchema.optional(),
}).strict();

export const pullRequestResultRequestSchema = z.object({
  status: pullRequestRecordStatusSchema.extract(["opened", "merged", "failed", "skipped"]),
  url: z.string().optional(),
  number: z.number().int().optional(),
  sha: z.string().optional(),
  error: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "failed" && (!value.error || value.error.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "error is required when status is failed",
      path: ["error"],
    });
  }
});

export type PullRequestResultRequest = z.infer<typeof pullRequestResultRequestSchema>;

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
