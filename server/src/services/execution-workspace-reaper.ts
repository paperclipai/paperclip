import fs from "node:fs/promises";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues, projects, projectWorkspaces } from "@paperclipai/db";
import type {
  ExecutionWorkspaceCloseReadiness,
  ExecutionWorkspaceReapItem,
  ExecutionWorkspaceReapReason,
  ExecutionWorkspaceReapReport,
  ExecutionWorkspaceStatus,
} from "@paperclipai/shared";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { executionWorkspaceService, readExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  stopRuntimeServicesForExecutionWorkspace,
} from "./workspace-runtime.js";

const ACTIVE_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const CLEANUP_WARNINGS_STORAGE_REASON = "cleanup_warnings";
const CLEANUP_FAILED_STORAGE_REASON = "cleanup_failed";
const CLEANUP_INCOMPLETE_STORAGE_REASON = "cleanup_incomplete";

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
type SourceIssueRow = Pick<typeof issues.$inferSelect, "id" | "identifier" | "status">;

export interface ExecutionWorkspaceReapOptions {
  dryRun?: boolean;
  deleteFiles?: boolean;
}

function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getWorkspacePath(row: ExecutionWorkspaceRow) {
  return readNullableString(row.providerRef) ?? readNullableString(row.cwd);
}

async function pathExists(value: string | null) {
  if (!value) return false;
  try {
    await fs.access(value);
    return true;
  } catch (error) {
    if (!error || typeof error !== "object") return true;
    const code = (error as { code?: unknown }).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

function getReportedReason(
  reasons: ExecutionWorkspaceReapReason[],
  fallback: ExecutionWorkspaceReapItem["reason"],
) {
  return reasons[0] ?? fallback;
}

function isArchiveCandidate(item: ExecutionWorkspaceReapItem) {
  return (
    item.plannedAction === "archive_record" ||
    item.plannedAction === "archive_record_and_delete_files" ||
    item.plannedAction === "archive_record_cleanup_skipped"
  );
}

function cleanupWarningReason(count: number) {
  return count === 1
    ? "filesystem cleanup reported 1 warning"
    : `filesystem cleanup reported ${count} warnings`;
}

function cleanupStorageReason(item: ExecutionWorkspaceReapItem, cleanupReason: string, warningCount = 0) {
  const warningSuffix = warningCount > 0 ? `:${warningCount}` : "";
  return `reaper:${item.reasons.join(",")}; cleanup:${cleanupReason}${warningSuffix}`;
}

function cleanupFailureReason(kind: "failed" | "incomplete", warningCount = 0) {
  const base = kind === "failed"
    ? "filesystem cleanup failed"
    : "filesystem cleanup did not remove workspace";
  return warningCount > 0 ? `${base}; ${cleanupWarningReason(warningCount)}` : base;
}

function disappearedBeforeArchive(item: ExecutionWorkspaceReapItem): ExecutionWorkspaceReapItem {
  return {
    ...item,
    reason: "none",
    reasons: [],
    pathExists: false,
    activeLinkedCount: 0,
    plannedAction: "noop_no_cleanup_reason",
    archived: false,
    cleanupAttempted: false,
    cleanupDeleted: false,
    cleanupSkippedReason: "workspace disappeared before archive",
  };
}

function isCleanupUnsafe(readiness: ExecutionWorkspaceCloseReadiness): string | null {
  if (readiness.state === "blocked" || !readiness.isDestructiveCloseAllowed) {
    return readiness.blockingReasons[0] ?? "close readiness is blocked";
  }
  if (readiness.isSharedWorkspace) return "shared workspace sessions are not filesystem cleanup targets";
  if (readiness.isProjectPrimaryWorkspace) return "project primary workspaces are not filesystem cleanup targets";

  const destructiveAction = readiness.plannedActions.some((action) =>
    action.kind === "git_worktree_remove" ||
    action.kind === "git_branch_delete" ||
    action.kind === "remove_local_directory"
  );
  if (!destructiveAction) return "no filesystem deletion action is planned";

  const git = readiness.git;
  if (!git) return null;
  if (git.hasDirtyTrackedFiles) return "workspace has modified tracked files";
  if (git.hasUntrackedFiles) return "workspace has untracked files";
  if (git.aheadCount !== null && git.aheadCount > 0 && git.isMergedIntoBase !== true) {
    return "workspace has unmerged commits ahead of its base ref";
  }
  if (git.aheadCount === null && git.baseRef) return "git ahead status is unavailable";
  if (git.isMergedIntoBase === false) return "workspace is not merged into its base ref";
  return null;
}

function makeReport(companyId: string, dryRun: boolean, deleteFiles: boolean, items: ExecutionWorkspaceReapItem[]): ExecutionWorkspaceReapReport {
  return {
    companyId,
    dryRun,
    deleteFiles,
    checkedCount: items.length,
    candidateCount: items.filter((item) =>
      item.plannedAction === "archive_record" ||
      item.plannedAction === "archive_record_and_delete_files" ||
      item.plannedAction === "archive_record_cleanup_skipped"
    ).length,
    archivedCount: items.filter((item) => item.archived).length,
    excludedActiveCount: items.filter((item) => item.plannedAction === "exclude_active_linked").length,
    noopArchivedCount: items.filter((item) => item.plannedAction === "noop_already_archived").length,
    noopNoReasonCount: items.filter((item) => item.plannedAction === "noop_no_cleanup_reason").length,
    items,
  };
}

export function executionWorkspaceReaperService(db: Db) {
  const workspaceSvc = executionWorkspaceService(db);
  const operationsSvc = workspaceOperationService(db);

  async function buildReapItems(companyId: string, deleteFiles: boolean, workspaceId?: string): Promise<ExecutionWorkspaceReapItem[]> {
    const rows = await db
      .select()
      .from(executionWorkspaces)
      .where(
        workspaceId
          ? and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, workspaceId))
          : eq(executionWorkspaces.companyId, companyId),
      )
      .orderBy(executionWorkspaces.id);
    const workspaceIds = rows.map((row) => row.id);
    const sourceIssueIds = Array.from(new Set(rows.map((row) => row.sourceIssueId).filter((value): value is string => Boolean(value))));

    const sourceIssues = sourceIssueIds.length > 0
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            status: issues.status,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, sourceIssueIds)))
      : [];
    const sourceIssueById = new Map<string, SourceIssueRow>(sourceIssues.map((issue) => [issue.id, issue]));

    const linkedIssues = workspaceIds.length > 0
      ? await db
          .select({
            executionWorkspaceId: issues.executionWorkspaceId,
            status: issues.status,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.executionWorkspaceId, workspaceIds)))
      : [];
    const activeLinkedCountByWorkspaceId = new Map<string, number>();
    for (const issue of linkedIssues) {
      if (!issue.executionWorkspaceId || !ACTIVE_ISSUE_STATUSES.includes(issue.status as typeof ACTIVE_ISSUE_STATUSES[number])) {
        continue;
      }
      activeLinkedCountByWorkspaceId.set(
        issue.executionWorkspaceId,
        (activeLinkedCountByWorkspaceId.get(issue.executionWorkspaceId) ?? 0) + 1,
      );
    }

    const items: ExecutionWorkspaceReapItem[] = [];
    for (const row of rows) {
      const sourceIssue = row.sourceIssueId ? sourceIssueById.get(row.sourceIssueId) ?? null : null;
      const workspacePath = getWorkspacePath(row);
      const exists = await pathExists(workspacePath);
      const activeLinkedCount = activeLinkedCountByWorkspaceId.get(row.id) ?? 0;
      const reasons: ExecutionWorkspaceReapReason[] = [];
      if (!sourceIssue) reasons.push("source_issue_missing");
      else if (TERMINAL_ISSUE_STATUSES.has(sourceIssue.status)) reasons.push("source_issue_terminal");
      if (!exists) reasons.push("path_missing");

      let plannedAction: ExecutionWorkspaceReapItem["plannedAction"];
      let cleanupSkippedReason: string | null = null;
      if (row.status === "archived") {
        plannedAction = "noop_already_archived";
      } else if (activeLinkedCount > 0) {
        plannedAction = "exclude_active_linked";
      } else if (reasons.length === 0) {
        plannedAction = "noop_no_cleanup_reason";
      } else if (deleteFiles) {
        const readiness = await workspaceSvc.getCloseReadiness(row.id);
        cleanupSkippedReason = readiness ? isCleanupUnsafe(readiness) : "close readiness unavailable";
        plannedAction = cleanupSkippedReason ? "archive_record_cleanup_skipped" : "archive_record_and_delete_files";
      } else {
        plannedAction = "archive_record";
      }

      const reason = row.status === "archived"
        ? "already_archived"
        : activeLinkedCount > 0
          ? "active_linked"
          : getReportedReason(reasons, "none");

      items.push({
        workspaceId: row.id,
        workspaceStatus: row.status as ExecutionWorkspaceStatus,
        sourceIssueIdentifier: sourceIssue?.identifier ?? null,
        sourceIssueStatus: sourceIssue?.status ?? null,
        reason,
        reasons,
        pathExists: exists,
        activeLinkedCount,
        plannedAction,
        archived: false,
        cleanupAttempted: false,
        cleanupDeleted: false,
        cleanupSkippedReason,
      });
    }

    return items;
  }

  async function buildApplyItem(companyId: string, workspaceId: string, deleteFiles: boolean) {
    return await buildReapItems(companyId, deleteFiles, workspaceId).then((items) => items[0] ?? null);
  }

  function sourceIssueMissingPredicate(companyId: string) {
    return sql`(
      ${executionWorkspaces.sourceIssueId} is null
      or not exists (
        select 1
        from ${issues}
        where ${issues.companyId} = ${companyId}
          and ${issues.id} = ${executionWorkspaces.sourceIssueId}
      )
    )`;
  }

  function sourceIssueTerminalPredicate(companyId: string) {
    return sql`exists (
      select 1
      from ${issues}
      where ${issues.companyId} = ${companyId}
        and ${issues.id} = ${executionWorkspaces.sourceIssueId}
        and ${issues.status} in ('done', 'cancelled')
    )`;
  }

  function cleanupReasonStillAppliesPredicate(companyId: string, item: ExecutionWorkspaceReapItem) {
    const predicates = [];
    if (item.reasons.includes("path_missing")) predicates.push(sql`true`);
    if (item.reasons.includes("source_issue_missing")) predicates.push(sourceIssueMissingPredicate(companyId));
    if (item.reasons.includes("source_issue_terminal")) predicates.push(sourceIssueTerminalPredicate(companyId));
    if (predicates.length === 0) return sql`false`;
    return predicates.length === 1 ? predicates[0]! : or(...predicates);
  }

  async function archiveWorkspace(companyId: string, item: ExecutionWorkspaceReapItem) {
    const now = new Date();
    const cleanupReason = `reaper:${item.reasons.join(",")}`;
    const archived = await db
      .update(executionWorkspaces)
      .set({
        status: "archived",
        closedAt: now,
        cleanupEligibleAt: now,
        cleanupReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(executionWorkspaces.id, item.workspaceId),
          eq(executionWorkspaces.companyId, companyId),
          sql`${executionWorkspaces.status} <> 'archived'`,
          cleanupReasonStillAppliesPredicate(companyId, item),
          sql`not exists (
            select 1
            from ${issues}
            where ${issues.companyId} = ${companyId}
              and ${issues.executionWorkspaceId} = ${executionWorkspaces.id}
              and ${issues.status} in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
          )`,
        ),
      )
      .returning({ id: executionWorkspaces.id });
    return archived.length > 0;
  }

  async function cleanupWorkspace(companyId: string, item: ExecutionWorkspaceReapItem): Promise<Pick<ExecutionWorkspaceReapItem, "cleanupAttempted" | "cleanupDeleted" | "cleanupSkippedReason">> {
    if (item.plannedAction !== "archive_record_and_delete_files") {
      return {
        cleanupAttempted: false,
        cleanupDeleted: false,
        cleanupSkippedReason: item.cleanupSkippedReason,
      };
    }

    const workspace = await workspaceSvc.getById(item.workspaceId);
    if (!workspace) {
      return {
        cleanupAttempted: false,
        cleanupDeleted: false,
        cleanupSkippedReason: "workspace disappeared before cleanup",
      };
    }
    const readiness = await workspaceSvc.getCloseReadiness(item.workspaceId);
    const unsafeReason = readiness ? isCleanupUnsafe(readiness) : "close readiness unavailable";
    if (unsafeReason) {
      return {
        cleanupAttempted: false,
        cleanupDeleted: false,
        cleanupSkippedReason: unsafeReason,
      };
    }

    let cleanup: Awaited<ReturnType<typeof cleanupExecutionWorkspaceArtifacts>>;
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
            .where(and(eq(projectWorkspaces.id, workspace.projectWorkspaceId), eq(projectWorkspaces.companyId, companyId)))
            .then((rows) => rows[0] ?? null)
        : null;
      const projectPolicy = workspace.projectId
        ? await db
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, workspace.projectId), eq(projects.companyId, companyId)))
            .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
        : null;
      const config = readExecutionWorkspaceConfig(workspace.metadata);

      cleanup = await cleanupExecutionWorkspaceArtifacts({
        workspace,
        projectWorkspace,
        teardownCommand: config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
        cleanupCommand: config?.cleanupCommand ?? null,
        recorder: operationsSvc.createRecorder({
          companyId,
          executionWorkspaceId: workspace.id,
        }),
      });
    } catch {
      await db
        .update(executionWorkspaces)
        .set({
          status: "cleanup_failed",
          cleanupReason: cleanupStorageReason(item, CLEANUP_FAILED_STORAGE_REASON),
          updatedAt: new Date(),
        })
        .where(and(eq(executionWorkspaces.id, item.workspaceId), eq(executionWorkspaces.companyId, companyId)));
      return {
        cleanupAttempted: true,
        cleanupDeleted: false,
        cleanupSkippedReason: cleanupFailureReason("failed"),
      };
    }

    if (cleanup.warnings.length > 0) {
      await db
        .update(executionWorkspaces)
        .set({
          cleanupReason: cleanupStorageReason(item, CLEANUP_WARNINGS_STORAGE_REASON, cleanup.warnings.length),
          updatedAt: new Date(),
        })
        .where(and(eq(executionWorkspaces.id, item.workspaceId), eq(executionWorkspaces.companyId, companyId)));
    }
    if (!cleanup.cleaned) {
      await db
        .update(executionWorkspaces)
        .set({
          status: "cleanup_failed",
          cleanupReason: cleanupStorageReason(item, CLEANUP_INCOMPLETE_STORAGE_REASON, cleanup.warnings.length),
          updatedAt: new Date(),
        })
        .where(and(eq(executionWorkspaces.id, item.workspaceId), eq(executionWorkspaces.companyId, companyId)));
      return {
        cleanupAttempted: true,
        cleanupDeleted: false,
        cleanupSkippedReason: cleanupFailureReason("incomplete", cleanup.warnings.length),
      };
    }

    return {
      cleanupAttempted: true,
      cleanupDeleted: cleanup.cleaned,
      cleanupSkippedReason: cleanup.warnings.length > 0 ? cleanupWarningReason(cleanup.warnings.length) : null,
    };
  }

  return {
    reap: async (companyId: string, options?: ExecutionWorkspaceReapOptions): Promise<ExecutionWorkspaceReapReport> => {
      const dryRun = options?.dryRun ?? true;
      const deleteFiles = options?.deleteFiles ?? false;
      const dryRunItems = await buildReapItems(companyId, deleteFiles);
      if (dryRun) {
        return makeReport(companyId, true, deleteFiles, dryRunItems);
      }

      const items: ExecutionWorkspaceReapItem[] = [];
      for (const item of dryRunItems) {
        if (!isArchiveCandidate(item)) {
          items.push(item);
          continue;
        }

        const applyItem = await buildApplyItem(companyId, item.workspaceId, deleteFiles);
        if (!applyItem) {
          items.push(disappearedBeforeArchive(item));
          continue;
        }
        if (!isArchiveCandidate(applyItem)) {
          items.push(applyItem);
          continue;
        }

        const archived = await archiveWorkspace(companyId, applyItem);
        const cleanup = archived
          ? await cleanupWorkspace(companyId, applyItem)
          : {
              cleanupAttempted: false,
              cleanupDeleted: false,
              cleanupSkippedReason: "workspace became ineligible before archive",
            };
        items.push({
          ...applyItem,
          archived,
          cleanupAttempted: cleanup.cleanupAttempted,
          cleanupDeleted: cleanup.cleanupDeleted,
          cleanupSkippedReason: cleanup.cleanupSkippedReason,
        });
      }

      return makeReport(companyId, false, deleteFiles, items);
    },
  };
}
