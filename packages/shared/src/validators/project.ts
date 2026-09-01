import { z } from "zod";
import { PROJECT_STATUSES, PROJECT_ICON_NAMES } from "../constants.js";
import { envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema } from "./trust-policy.js";
import { objectWithoutDefaults } from "./partial.js";

const executionWorktreeStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    runtimeProvisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const projectExecutionWorktreePolicySchema = z
  .object({
    enabled: z.boolean(),
    sharedWorkspaceConcurrency: z.enum(["auto", "serialize", "allow"]).optional(),
    defaultMode: z.enum(["shared_workspace", "isolated_workspace", "operator_branch", "adapter_default"]).optional(),
    allowIssueOverride: z.boolean().optional(),
    defaultProjectWorkspaceId: z.string().guid().optional().nullable(),
    environmentId: z.string().guid().optional().nullable(),
    workspaceStrategy: executionWorktreeStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
    branchPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    pullRequestPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    runtimePolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    cleanupPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    authorizationPolicy: trustAuthorizationPolicySchema.optional().nullable(),
  })
  .strict();

export const projectWorktreeRuntimeConfigSchema = z.object({
  workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
  desiredState: z.enum(["running", "stopped", "manual"]).optional().nullable(),
  serviceStates: z.record(z.string(), z.enum(["running", "stopped", "manual"])).optional().nullable(),
}).strict();

const projectWorktreeSourceTypeSchema = z.enum(["local_path", "git_repo", "remote_managed", "non_git_path"]);
const projectWorktreeVisibilitySchema = z.enum(["default", "advanced"]);

const projectWorktreeFields = {
  name: z.string().min(1).optional(),
  sourceType: projectWorktreeSourceTypeSchema.optional(),
  cwd: z.string().min(1).optional().nullable(),
  repoUrl: z.string().url().optional().nullable(),
  repoRef: z.string().optional().nullable(),
  defaultRef: z.string().optional().nullable(),
  visibility: projectWorktreeVisibilitySchema.optional(),
  setupCommand: z.string().optional().nullable(),
  cleanupCommand: z.string().optional().nullable(),
  remoteProvider: z.string().optional().nullable(),
  remoteWorkspaceRef: z.string().optional().nullable(),
  sharedWorkspaceKey: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  runtimeConfig: projectWorktreeRuntimeConfigSchema.optional().nullable(),
};

function validateProjectWorktree(value: Record<string, unknown>, ctx: z.RefinementCtx) {
  const sourceType = value.sourceType ?? "local_path";
  const hasCwd = typeof value.cwd === "string" && value.cwd.trim().length > 0;
  const hasRepo = typeof value.repoUrl === "string" && value.repoUrl.trim().length > 0;
  const hasRemoteRef = typeof value.remoteWorkspaceRef === "string" && value.remoteWorkspaceRef.trim().length > 0;

  if (sourceType === "remote_managed") {
    if (!hasRemoteRef && !hasRepo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Remote-managed workspace requires remoteWorkspaceRef or repoUrl.",
        path: ["remoteWorkspaceRef"],
      });
    }
    return;
  }

  if (!hasCwd && !hasRepo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workspace requires at least one of cwd or repoUrl.",
      path: ["cwd"],
    });
  }
}

export const createProjectWorktreeSchema = z.object({
  ...projectWorktreeFields,
  isPrimary: z.boolean().optional().default(false),
}).superRefine(validateProjectWorktree);

export type CreateProjectWorktree = z.infer<typeof createProjectWorktreeSchema>;

export const updateProjectWorktreeSchema = z.object({
  ...projectWorktreeFields,
  isPrimary: z.boolean().optional(),
}).partial();

export type UpdateProjectWorktree = z.infer<typeof updateProjectWorktreeSchema>;

const projectFields = {
  /** @deprecated Use goalIds instead */
  goalId: z.string().guid().optional().nullable(),
  goalIds: z.array(z.string().guid()).optional(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(PROJECT_STATUSES).optional().default("backlog"),
  leadAgentId: z.string().guid().optional().nullable(),
  targetDate: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  icon: z.enum(PROJECT_ICON_NAMES).optional().nullable(),
  env: envConfigSchema.optional().nullable(),
  executionWorkspacePolicy: projectExecutionWorktreePolicySchema.optional().nullable(),
  archivedAt: z.string().datetime().optional().nullable(),
};

export const createProjectSchema = z.object({
  ...projectFields,
  workspace: createProjectWorktreeSchema.optional(),
});

export type CreateProject = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = objectWithoutDefaults(
  z.object(projectFields),
).partial();

export type UpdateProject = z.infer<typeof updateProjectSchema>;

export type ProjectExecutionWorktreePolicy = z.infer<typeof projectExecutionWorktreePolicySchema>;
