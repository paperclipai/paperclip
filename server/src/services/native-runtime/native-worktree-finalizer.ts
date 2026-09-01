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
import { worktreeOperationService } from "../worktree-operations.js";
import { inspectManagedGitWorktreeBranch } from "../worktree-runtime.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resume the real worktree-finalization action for a result-bearing native
 * run. This service observes the worktree; it never fabricates a successful
 * marker. The caller decides whether a failed observation is retryable.
 */
export async function resumeNativeWorktreeFinalization(input: {
  db: Db;
  runId: string;
}) {
  const bound = await input.db.select({
    companyId: heartbeatRuns.companyId,
    runtimeMode: heartbeatRuns.runtimeMode,
    runnerProfileJson: heartbeatRuns.runnerProfileJson,
    issueId: nativeRunFinalizations.issueId,
    resultId: nativeRunFinalizations.resultId,
    issueWorktreeId: issues.executionWorkspaceId,
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

  const persistedInput = record(record(bound.runnerProfileJson).nativeExecutionInput);
  const binding = record(persistedInput.binding);
  const worktreeId = previous?.executionWorkspaceId
    ?? bound.issueWorktreeId
    ?? readString(binding.executionWorkspaceId);
  const worktree = worktreeId
    ? await input.db.select().from(executionWorkspaces).where(and(
        eq(executionWorkspaces.id, worktreeId),
        eq(executionWorkspaces.companyId, bound.companyId),
      )).limit(1).then((rows) => rows[0] ?? null)
    : null;
  const cwd = worktree?.providerRef ?? worktree?.cwd ?? previous?.cwd ?? null;

  const recorder = worktreeOperationService(input.db).createRecorder({
    companyId: bound.companyId,
    heartbeatRunId: input.runId,
    executionWorkspaceId: worktree?.id ?? worktreeId,
    issueId: bound.issueId,
  });
  return recorder.recordOperation({
    phase: "workspace_finalize",
    cwd,
    metadata: {
      resumedFromOperationId: previous?.id ?? null,
      owningService: "native_worktree_finalizer",
      observation: worktree?.strategyType === "git_worktree"
        ? "managed_git_worktree_branch"
        : "worktree_directory",
    },
    run: async () => {
      if (!cwd) {
        return {
          status: "failed",
          exitCode: 1,
          stderr: "Native worktree finalization cannot resolve the persisted worktree path.\n",
        };
      }
      const isDirectory = await fs.stat(cwd).then((stat) => stat.isDirectory()).catch(() => false);
      if (!isDirectory) {
        return {
          status: "failed",
          exitCode: 1,
          stderr: `Native worktree finalization could not access worktree directory ${cwd}.\n`,
        };
      }
      if (worktree?.strategyType === "git_worktree") {
        const inspection = await inspectManagedGitWorktreeBranch({
          worktreePath: cwd,
          expectedBranchName: worktree.branchName,
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
          system: "Native worktree finalization validated the managed git worktree.\n",
          metadata: { managedGitWorktreeBranch: inspection },
        };
      }
      return {
        status: "succeeded",
        exitCode: 0,
        system: "Native worktree finalization validated the persisted worktree directory.\n",
        metadata: { observedWorktreePath: cwd },
      };
    },
  });
}
