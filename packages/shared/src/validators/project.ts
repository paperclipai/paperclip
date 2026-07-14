import { z } from "zod";
import { PROJECT_STATUSES, PROJECT_ICON_NAMES } from "../constants.js";
import { envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema } from "./trust-policy.js";

const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const projectExecutionWorkspacePolicySchema = z
  .object({
    enabled: z.boolean(),
    defaultMode: z.enum(["shared_workspace", "isolated_workspace", "operator_branch", "adapter_default"]).optional(),
    allowIssueOverride: z.boolean().optional(),
    defaultProjectWorkspaceId: z.string().uuid().optional().nullable(),
    environmentId: z.string().uuid().optional().nullable(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
    branchPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    pullRequestPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    runtimePolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    cleanupPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    authorizationPolicy: trustAuthorizationPolicySchema.optional().nullable(),
  })
  .strict();

export const projectWorkspaceRuntimeConfigSchema = z.object({
  workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
  desiredState: z.enum(["running", "stopped", "manual"]).optional().nullable(),
  serviceStates: z.record(z.enum(["running", "stopped", "manual"])).optional().nullable(),
}).strict();

const projectWorkspaceSourceTypeSchema = z.enum(["local_path", "git_repo", "remote_managed", "non_git_path"]);
const projectWorkspaceVisibilitySchema = z.enum(["default", "advanced"]);

const projectWorkspaceFields = {
  name: z.string().min(1).optional(),
  sourceType: projectWorkspaceSourceTypeSchema.optional(),
  cwd: z.string().min(1).optional().nullable(),
  repoUrl: z.string().url().optional().nullable(),
  repoRef: z.string().optional().nullable(),
  defaultRef: z.string().optional().nullable(),
  visibility: projectWorkspaceVisibilitySchema.optional(),
  setupCommand: z.string().optional().nullable(),
  cleanupCommand: z.string().optional().nullable(),
  remoteProvider: z.string().optional().nullable(),
  remoteWorkspaceRef: z.string().optional().nullable(),
  sharedWorkspaceKey: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  runtimeConfig: projectWorkspaceRuntimeConfigSchema.optional().nullable(),
};

function validateProjectWorkspace(value: Record<string, unknown>, ctx: z.RefinementCtx) {
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

export const createProjectWorkspaceSchema = z.object({
  ...projectWorkspaceFields,
  isPrimary: z.boolean().optional().default(false),
}).superRefine(validateProjectWorkspace);

export type CreateProjectWorkspace = z.infer<typeof createProjectWorkspaceSchema>;

export const updateProjectWorkspaceSchema = z.object({
  ...projectWorkspaceFields,
  isPrimary: z.boolean().optional(),
}).partial();

export type UpdateProjectWorkspace = z.infer<typeof updateProjectWorkspaceSchema>;

const projectFields = {
  /** @deprecated Use goalIds instead */
  goalId: z.string().uuid().optional().nullable(),
  goalIds: z.array(z.string().uuid()).optional(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(PROJECT_STATUSES).optional().default("backlog"),
  leadAgentId: z.string().uuid().optional().nullable(),
  targetDate: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  icon: z.enum(PROJECT_ICON_NAMES).optional().nullable(),
  env: envConfigSchema.optional().nullable(),
  executionWorkspacePolicy: projectExecutionWorkspacePolicySchema.optional().nullable(),
  archivedAt: z.string().datetime().optional().nullable(),
};

const projectEnvPatchSchema = z
  .object({
    set: envConfigSchema.optional(),
    remove: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch.set ?? {}).length > 0 || (patch.remove?.length ?? 0) > 0,
    "Environment patch must set or remove at least one binding.",
  );

export const createProjectSchema = z.object({
  ...projectFields,
  workspace: createProjectWorkspaceSchema.optional(),
});

export type CreateProject = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    ...projectFields,
    envPatch: projectEnvPatchSchema.optional(),
  })
  .partial()
  .refine((update) => update.env === undefined || update.envPatch === undefined, {
    message: "Use either env or envPatch, not both.",
    path: ["envPatch"],
  });

export type UpdateProject = z.infer<typeof updateProjectSchema>;

export type ProjectExecutionWorkspacePolicy = z.infer<typeof projectExecutionWorkspacePolicySchema>;
