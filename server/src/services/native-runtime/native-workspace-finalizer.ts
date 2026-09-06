import fs from "node:fs/promises";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  workspaceOperations,
} from "@paperclipai/db";
import { workspaceOperationService } from "../workspace-operations.js";
import { inspectManagedGitWorktreeBranch } from "../workspace-runtime.js";
import { environmentService } from "../environments.js";
import type { EnvironmentRuntimeService } from "../environment-runtime.js";
import { resolveEnvironmentExecutionTarget } from "../environment-execution-target.js";
import {
  readNativeWorkspaceSyncReference,
  resumeNativeWorkspaceSync,
} from "./native-workspace-sync.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function workspaceSyncFailure(
  code: "workspace_sync_out_failed" | "workspace_sync_out_unrecoverable",
) {
  return {
    status: "failed" as const,
    exitCode: 1,
    stderr: `${code}\n`,
    metadata: { workspaceSync: { code } },
  };
}

/**
 * Resume the real workspace-finalization action for a result-bearing native
 * run. Durable sandbox-backed runs export and merge the remote workspace;
 * older runs retain the local workspace validation path. The caller owns the
 * durable retry and failure policy.
 */
export async function resumeNativeWorkspaceFinalization(input: {
  db: Db;
  runId: string;
  environmentRuntime?: EnvironmentRuntimeService;
}) {
  const bound = await input.db.select({
    companyId: heartbeatRuns.companyId,
    runtimeMode: heartbeatRuns.runtimeMode,
    runnerProfileJson: heartbeatRuns.runnerProfileJson,
    issueId: nativeRunFinalizations.issueId,
    resultId: nativeRunFinalizations.resultId,
    issueWorkspaceId: issues.executionWorkspaceId,
  })
    .from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .innerJoin(issues, and(
      eq(issues.id, nativeRunFinalizations.issueId),
      eq(issues.companyId, heartbeatRuns.companyId),
    ))
    .where(eq(heartbeatRuns.id, input.runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!bound || bound.runtimeMode !== "native" || !bound.resultId) {
    throw new Error("native_workspace_finalization_binding_missing");
  }

  const previous = await input.db.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, bound.companyId),
    eq(workspaceOperations.heartbeatRunId, input.runId),
    eq(workspaceOperations.phase, "workspace_finalize"),
  )).orderBy(desc(workspaceOperations.createdAt)).limit(1).then((rows) => rows[0] ?? null);

  const persistedInput = record(
    record(bound.runnerProfileJson).nativeExecutionInput,
  );
  const nativeWorkspaceSync = readNativeWorkspaceSyncReference(
    record(bound.runnerProfileJson).nativeWorkspaceSync,
  );
  const binding = record(persistedInput.binding);
  const workspaceId = previous?.executionWorkspaceId
    ?? bound.issueWorkspaceId
    ?? readString(binding.executionWorkspaceId);
  const workspace = workspaceId
    ? await input.db.select().from(executionWorkspaces).where(and(
        eq(executionWorkspaces.id, workspaceId),
        eq(executionWorkspaces.companyId, bound.companyId),
      )).limit(1).then((rows) => rows[0] ?? null)
    : null;
  const cwd = workspace?.providerRef ?? workspace?.cwd ?? previous?.cwd ?? null;

  const recorder = workspaceOperationService(input.db).createRecorder({
    companyId: bound.companyId,
    heartbeatRunId: input.runId,
    executionWorkspaceId: workspace?.id ?? workspaceId,
    issueId: bound.issueId,
  });
  return recorder.recordOperation({
    phase: "workspace_finalize",
    cwd,
    metadata: {
      resumedFromOperationId: previous?.id ?? null,
      owningService: "native_workspace_finalizer",
      observation: workspace?.strategyType === "git_worktree"
        ? "managed_git_worktree_branch"
        : "workspace_directory",
    },
    run: async () => {
      if (nativeWorkspaceSync) {
        if (!input.environmentRuntime) {
          return {
            status: "failed",
            exitCode: 1,
            stderr:
              "Native workspace finalization cannot access the environment runtime.\n",
          };
        }
        const environmentsSvc = environmentService(input.db);
        const lease = await environmentsSvc.getLeaseById(
          nativeWorkspaceSync.leaseId,
        );
        const environment = lease?.environmentId
          ? await environmentsSvc.getById(lease.environmentId)
          : null;
        if (
          !lease ||
          !environment ||
          lease.companyId !== bound.companyId ||
          environment.id !== lease.environmentId
        ) {
          return workspaceSyncFailure("workspace_sync_out_unrecoverable");
        }
        if (
          lease.status === "expired" ||
          lease.status === "failed" ||
          lease.status === "pending_cleanup" ||
          !lease.providerLeaseId ||
          lease.providerLeaseId !== nativeWorkspaceSync.providerLeaseId
        ) {
          return workspaceSyncFailure("workspace_sync_out_unrecoverable");
        }
        const target = await resolveEnvironmentExecutionTarget({
          db: input.db,
          companyId: bound.companyId,
          adapterType: "paperclip_runner",
          environment,
          leaseId: lease.id,
          leaseMetadata: lease.metadata,
          lease,
          environmentRuntime: input.environmentRuntime,
        });
        if (!target) {
          return {
            status: "failed",
            exitCode: 1,
            stderr: "Native workspace finalization target is unavailable.\n",
          };
        }
        try {
          const restored = await resumeNativeWorkspaceSync({
            db: input.db,
            runId: input.runId,
            target,
          });
          if (!restored) {
            return workspaceSyncFailure("workspace_sync_out_unrecoverable");
          }
          return {
            status: "succeeded",
            exitCode: 0,
            system:
              "Native workspace finalization restored the remote workspace.\n",
            metadata: {
              workspaceSync: {
                schema: nativeWorkspaceSync.schema,
                workspaceId: nativeWorkspaceSync.workspaceId,
                leaseId: nativeWorkspaceSync.leaseId,
              },
            },
          };
        } catch (error) {
          const code =
            error instanceof Error &&
            (error.message === "workspace_sync_out_unrecoverable" ||
              error.message.includes("daytona_sandbox_not_found"))
              ? "workspace_sync_out_unrecoverable"
              : "workspace_sync_out_failed";
          return workspaceSyncFailure(code);
        }
      }
      if (!cwd) {
        return {
          status: "failed",
          exitCode: 1,
          stderr: "Native workspace finalization cannot resolve the persisted workspace path.\n",
        };
      }
      const isDirectory = await fs.stat(cwd).then((stat) => stat.isDirectory()).catch(() => false);
      if (!isDirectory) {
        return {
          status: "failed",
          exitCode: 1,
          stderr: `Native workspace finalization could not access workspace directory ${cwd}.\n`,
        };
      }
      if (workspace?.strategyType === "git_worktree") {
        const inspection = await inspectManagedGitWorktreeBranch({
          worktreePath: cwd,
          expectedBranchName: workspace.branchName,
        });
        if (!inspection.valid) {
          return {
            status: "failed",
            exitCode: 1,
            stderr: `Managed git worktree validation failed: ${inspection.reason ?? "unknown failure"}.\n`,
            metadata: { managedGitWorktreeBranch: inspection },
          };
        }
        return {
          status: "succeeded",
          exitCode: 0,
          system: "Native workspace finalization validated the managed git worktree.\n",
          metadata: { managedGitWorktreeBranch: inspection },
        };
      }
      return {
        status: "succeeded",
        exitCode: 0,
        system: "Native workspace finalization validated the persisted workspace directory.\n",
        metadata: { observedWorkspacePath: cwd },
      };
    },
  });
}
