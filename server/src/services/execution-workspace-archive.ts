import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, projectWorkspaces, projects } from "@paperclipai/db";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { readExecutionWorkspaceConfig } from "./execution-workspaces.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  stopRuntimeServicesForExecutionWorkspace,
} from "./workspace-runtime.js";
import { workspaceOperationService } from "./workspace-operations.js";

export interface RunArchiveSideEffectsInput {
  db: Db;
  workspace: ExecutionWorkspace;
  closedAt?: Date;
}

export interface RunArchiveSideEffectsResult {
  cleanupWarnings: string[];
  cleaned: boolean;
  status: "archived" | "cleanup_failed";
  cleanupReason: string | null;
  closedAt: Date;
  error?: string;
}

/**
 * Runs the side effects that must accompany any workspace archive:
 * detaches linked issues for shared workspaces, stops attached
 * runtime services, and runs the cleanup / teardown commands per
 * project policy.
 *
 * The helper is called from three sites that all need the same
 * post-archive behavior:
 *
 *   - PATCH archive (fire-and-forget and no-policy paths)
 *   - POST /pull-request/result on a blocking terminal transition
 *     (merged | skipped) that moves the workspace to `archived`
 *   - The archive-timeout scheduler when it forces a skipped
 *     resolution and moves the workspace to `archived`
 *
 * Before this helper existed, only PATCH archive ran these side
 * effects, so blocking-mode workspaces could end up in `archived`
 * without any teardown, with their runtime services still running
 * and their linked issues still pointing at the archived workspace.
 * Pulling the block here keeps the three close paths bit-for-bit
 * equivalent on everything except the state-machine transition that
 * triggered them.
 *
 * The helper is a no-throw: any cleanup failure is surfaced through
 * the returned `status: "cleanup_failed"`, with the error string on
 * `error`. Callers decide whether to downgrade the workspace record
 * and how to surface the failure to clients.
 */
export async function runArchiveSideEffects(
  input: RunArchiveSideEffectsInput,
): Promise<RunArchiveSideEffectsResult> {
  const { db, workspace } = input;
  const closedAt = input.closedAt ?? new Date();

  if (workspace.mode === "shared_workspace") {
    await db
      .update(issues)
      .set({
        executionWorkspaceId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issues.companyId, workspace.companyId),
          eq(issues.executionWorkspaceId, workspace.id),
        ),
      );
  }

  const configForCleanup = readExecutionWorkspaceConfig(workspace.metadata);

  try {
    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId: workspace.id,
      workspaceCwd: workspace.cwd,
    });
    const projectWorkspace = workspace.projectWorkspaceId
      ? await db
          .select({
            cwd: projectWorkspaces.cwd,
            cleanupCommand: projectWorkspaces.cleanupCommand,
          })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.id, workspace.projectWorkspaceId),
              eq(projectWorkspaces.companyId, workspace.companyId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const projectPolicy = workspace.projectId
      ? await db
          .select({
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, workspace.projectId),
              eq(projects.companyId, workspace.companyId),
            ),
          )
          .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
      : null;
    const cleanupResult = await cleanupExecutionWorkspaceArtifacts({
      workspace,
      projectWorkspace,
      teardownCommand:
        configForCleanup?.teardownCommand ??
        projectPolicy?.workspaceStrategy?.teardownCommand ??
        null,
      cleanupCommand: configForCleanup?.cleanupCommand ?? null,
      recorder: workspaceOperationService(db).createRecorder({
        companyId: workspace.companyId,
        executionWorkspaceId: workspace.id,
      }),
    });
    return {
      cleanupWarnings: cleanupResult.warnings,
      cleaned: cleanupResult.cleaned,
      status: cleanupResult.cleaned ? "archived" : "cleanup_failed",
      cleanupReason:
        cleanupResult.warnings.length > 0 ? cleanupResult.warnings.join(" | ") : null,
      closedAt,
    };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    return {
      cleanupWarnings: [failureReason],
      cleaned: false,
      status: "cleanup_failed",
      cleanupReason: failureReason,
      closedAt,
      error: failureReason,
    };
  }
}
