import { z } from "zod";
import { workspaceProviderBindingSchema } from "@paperclipai/shared";

const recoveryFile = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive(),
}).strict();
export const freshWorkspaceSchema = z.object({
  attemptId: z.string().uuid(),
  sourceRunId: z.string().uuid(),
  previousWorkspaceId: z.string().uuid().nullable(),
  recoverySnapshots: z.array(z.object({
    operationId: z.string().uuid(), sourceRunId: z.string().uuid(),
    archive: recoveryFile, manifest: recoveryFile,
  }).strict()),
}).strict();
export type PluginFreshWorkspace = z.infer<typeof freshWorkspaceSchema>;

const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const workspaceProviderOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prepare"),
      source: z
        .object({
          id: z.string().uuid(),
          revision: z.string().min(1).max(256),
          repoUrl: z.string().url().nullable(),
          repoRef: z.string().nullable(),
          defaultRef: z.string().nullable(),
        })
        .strict(),
      mode: z.enum([
        "shared_workspace",
        "isolated_workspace",
        "operator_branch",
      ]),
      strategy: z.enum(["project_primary", "git_worktree"]),
      branchName: z.string().min(1).max(256).nullable(),
      branchMode: z.enum(["create", "existing"]).optional(),
      baseRef: z.string().nullable(),
      existing: workspaceProviderBindingSchema.nullable(),
      fresh: freshWorkspaceSchema.optional(),
    })
    .strict(),
  // Verify the retained workspace and flush run writes. This does not certify
  // remote recoverability or authorize removal; dirty work is valid output.
  z.object({ kind: z.literal("finalize"), binding: workspaceProviderBindingSchema }).strict(),
  z
    .object({
      kind: z.literal("inspect"),
      binding: workspaceProviderBindingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove"),
      binding: workspaceProviderBindingSchema,
      expectedHeadSha: sha.nullable(),
    })
    .strict(),
]);
export const workspaceProviderResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prepared"),
      binding: workspaceProviderBindingSchema,
      branchName: z.string().min(1).max(256).nullable(),
      baseSha: sha.nullable(),
      created: z.boolean(),
      branchCreatedByRuntime: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspection"),
      headSha: sha.nullable(),
      branchName: z.string().nullable(),
      hasDirtyTrackedFiles: z.boolean(),
      hasUntrackedFiles: z.boolean(),
      hasLocalOnlyData: z.boolean(),
      isMergedIntoBase: z.boolean().nullable(),
      remotelyRecoverable: z.boolean().nullable(),
    })
    .strict(),
  // Return only after retained files are durable and their identity is verified.
  z.object({ kind: z.literal("finalized"), headSha: sha.nullable(), branchName: z.string().nullable() }).strict(),
  // Return only after removal is confirmed. Busy, failed and uncertain operations must throw.
  z.object({ kind: z.literal("removed") }).strict(),
]);
export type PluginWorkspaceOperation = z.infer<
  typeof workspaceProviderOperationSchema
>;
export type PluginWorkspaceResult = z.infer<
  typeof workspaceProviderResultSchema
>;
export const pluginWorkspaceParamsSchema = z
  .object({
    pluginId: z.string().uuid(),
    companyId: z.string().uuid(),
    projectId: z.string().uuid(),
    executionWorkspaceId: z.string().uuid(),
    /** Stable across ambiguous retries; reconcile before repeating effects. */
    operationId: z.string().min(1).max(256),
    generation: z.number().int().nonnegative(),
    deadline: z.string().datetime(),
    runId: z.string().uuid().nullable(),
    agentId: z.string().uuid().nullable(),
    operation: workspaceProviderOperationSchema,
  })
  .strict();
/** Finalization receives the originating run/agent context; maintenance remains agent-independent. */
export type PluginWorkspaceParams = z.infer<typeof pluginWorkspaceParamsSchema>;

export function parseWorkspaceProviderResult(
  params: PluginWorkspaceParams,
  value: unknown,
): PluginWorkspaceResult {
  const result = workspaceProviderResultSchema.parse(value);
  const expected =
    params.operation.kind === "prepare"
      ? "prepared"
      : params.operation.kind === "inspect"
        ? "inspection"
        : params.operation.kind === "finalize" ? "finalized" : "removed";
  if (result.kind !== expected)
    throw new Error("Workspace provider returned the wrong operation result");
  if (
    result.kind === "prepared" &&
    (result.binding.pluginId !== params.pluginId ||
      result.binding.executionWorkspaceId !== params.executionWorkspaceId ||
      result.binding.projectId !== params.projectId ||
      result.binding.projectWorkspaceId !==
        (params.operation.kind === "prepare"
          ? params.operation.source.id
          : undefined) ||
      result.binding.sourceRevision !==
        (params.operation.kind === "prepare"
          ? params.operation.source.revision
          : undefined))
  ) {
    throw new Error("Workspace provider returned a different source binding");
  }
  if (
    result.kind === "prepared" &&
    params.operation.kind === "prepare" &&
    params.operation.branchName &&
    result.branchName !== params.operation.branchName
  ) {
    throw new Error("Workspace provider returned a different branch");
  }
  return result;
}
