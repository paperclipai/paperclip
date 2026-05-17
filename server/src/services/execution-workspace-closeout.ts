import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues, projectWorkspaces, projects } from "@paperclipai/db";
import type { ExecutionWorkspace, ExecutionWorkspaceCloseReadiness } from "@paperclipai/shared";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { executionWorkspaceService, readExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { cleanupExecutionWorkspaceArtifacts, stopRuntimeServicesForExecutionWorkspace } from "./workspace-runtime.js";

export type ExecutionWorkspaceCloseMode = "manual" | "issue_completion";

export type ExecutionWorkspaceCloseResult = {
  outcome: "archived" | "cleanup_failed" | "blocked" | "error" | "already_archived";
  workspace: ExecutionWorkspace;
  closeReadiness: ExecutionWorkspaceCloseReadiness | null;
  cleanupWarnings: string[];
  blockingReasons: string[];
  failureReason: string | null;
};

function linkedOpenIssues(readiness: ExecutionWorkspaceCloseReadiness) {
  return (readiness.linkedIssues ?? []).filter((issue) => issue.isTerminal === false);
}

function gitDirtyMessage(label: "tracked" | "untracked", count: number) {
  const fileLabel =
    count === 1
      ? label === "tracked" ? "modified tracked file" : "untracked file"
      : label === "tracked" ? "modified tracked files" : "untracked files";
  return `Automatic issue-completion closeout requires a clean workspace; found ${count} ${fileLabel}.`;
}

function autoCloseBlockingReasons(readiness: ExecutionWorkspaceCloseReadiness): string[] {
  const reasons: string[] = [];
  const plannedActionKinds = new Set((readiness.plannedActions ?? []).map((action) => action.kind));
  const hasDestructiveWorkspaceRemoval =
    plannedActionKinds.has("git_worktree_remove") || plannedActionKinds.has("remove_local_directory");

  if (readiness.isSharedWorkspace && linkedOpenIssues(readiness).length > 0) {
    reasons.push("Automatic issue-completion closeout skipped because this shared workspace session is still linked to open issues.");
  }

  if (!hasDestructiveWorkspaceRemoval || !readiness.git) {
    return reasons;
  }

  if (readiness.git.hasDirtyTrackedFiles) {
    reasons.push(gitDirtyMessage("tracked", readiness.git.dirtyEntryCount));
  }
  if (readiness.git.hasUntrackedFiles) {
    reasons.push(gitDirtyMessage("untracked", readiness.git.untrackedEntryCount));
  }

  if (plannedActionKinds.has("git_worktree_remove")) {
    if (readiness.git.isMergedIntoBase === false) {
      reasons.push(
        `Automatic issue-completion closeout skipped because this workspace is not merged into ${readiness.git.baseRef ?? "its base ref"}.`,
      );
    } else if (readiness.git.isMergedIntoBase !== true) {
      reasons.push(
        `Automatic issue-completion closeout skipped because Paperclip could not confirm this workspace is merged into ${readiness.git.baseRef ?? "its base ref"}.`,
      );
    }
  }

  return reasons;
}

export async function closeExecutionWorkspace(
  db: Db,
  input: {
    executionWorkspaceId: string;
    mode?: ExecutionWorkspaceCloseMode;
    patch?: Partial<typeof executionWorkspaces.$inferInsert>;
  },
): Promise<ExecutionWorkspaceCloseResult | null> {
  const svc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const mode = input.mode ?? "manual";

  const existing = await svc.getById(input.executionWorkspaceId);
  if (!existing) return null;

  if (existing.status === "archived") {
    return {
      outcome: "already_archived",
      workspace: existing,
      closeReadiness: null,
      cleanupWarnings: [],
      blockingReasons: [],
      failureReason: null,
    };
  }

  const readiness = await svc.getCloseReadiness(existing.id);
  if (!readiness) return null;
  const effectiveConfig = input.patch?.metadata !== undefined
    ? readExecutionWorkspaceConfig((input.patch.metadata as Record<string, unknown> | null | undefined) ?? null)
    : existing.config;

  const blockingReasons = [
    ...(readiness.state === "blocked" ? readiness.blockingReasons : []),
    ...(mode === "issue_completion" ? autoCloseBlockingReasons(readiness) : []),
  ];
  if (blockingReasons.length > 0) {
    return {
      outcome: "blocked",
      workspace: existing,
      closeReadiness: readiness,
      cleanupWarnings: [],
      blockingReasons,
      failureReason: null,
    };
  }

  const closedAt = new Date();
  let workspace =
    (await svc.update(existing.id, {
      ...(input.patch ?? {}),
      status: "archived",
      closedAt,
      cleanupReason: null,
    })) ?? existing;

  if (existing.mode === "shared_workspace") {
    await db
      .update(issues)
      .set({
        executionWorkspaceId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issues.companyId, existing.companyId),
          eq(issues.executionWorkspaceId, existing.id),
        ),
      );
  }

  try {
    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId: existing.id,
      workspaceCwd: existing.cwd,
    });

    const projectWorkspace = existing.projectWorkspaceId
      ? await db
          .select({
            cwd: projectWorkspaces.cwd,
            cleanupCommand: projectWorkspaces.cleanupCommand,
          })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.id, existing.projectWorkspaceId),
              eq(projectWorkspaces.companyId, existing.companyId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;

    const projectPolicy = existing.projectId
      ? await db
          .select({
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(and(eq(projects.id, existing.projectId), eq(projects.companyId, existing.companyId)))
          .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
      : null;

    const cleanupResult = await cleanupExecutionWorkspaceArtifacts({
      workspace: existing,
      projectWorkspace,
      teardownCommand: effectiveConfig?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
      cleanupCommand: effectiveConfig?.cleanupCommand ?? null,
      recorder: workspaceOperationsSvc.createRecorder({
        companyId: existing.companyId,
        executionWorkspaceId: existing.id,
      }),
    });

    const cleanupWarnings = cleanupResult.warnings;
    const preserveProjectPrimaryWorkspace =
      readiness.isSharedWorkspace &&
      readiness.isProjectPrimaryWorkspace &&
      existing.providerType === "local_fs";

    if (cleanupWarnings.length > 0 || (!cleanupResult.cleaned && !preserveProjectPrimaryWorkspace)) {
      workspace =
        (await svc.update(existing.id, {
          closedAt,
          cleanupReason: cleanupWarnings.length > 0 ? cleanupWarnings.join(" | ") : null,
          ...(!cleanupResult.cleaned && !preserveProjectPrimaryWorkspace ? { status: "cleanup_failed" as const } : {}),
        })) ?? workspace;
    }

    return {
      outcome: workspace.status === "cleanup_failed" ? "cleanup_failed" : "archived",
      workspace,
      closeReadiness: readiness,
      cleanupWarnings,
      blockingReasons: [],
      failureReason: null,
    };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    workspace =
      (await svc.update(existing.id, {
        status: "cleanup_failed",
        closedAt,
        cleanupReason: failureReason,
      })) ?? workspace;

    return {
      outcome: "error",
      workspace,
      closeReadiness: readiness,
      cleanupWarnings: [],
      blockingReasons: [],
      failureReason,
    };
  }
}
