import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues } from "@paperclipai/db";
import { parseIssueExecutionWorkspaceSettings } from "./execution-workspace-policy.js";
import { loadParentChain } from "./issue-hierarchy.js";

type LineageReader = Pick<Db, "select" | "execute">;

/**
 * A subtask never shares a workspace with its parent or any other ancestor.
 * It may keep the ancestor's workspace *strategy* (mode, environment, runtime,
 * branch template, base ref), but nothing that names realized files: no
 * workspace id, no `reuse_existing` preference, and no pinned existing branch.
 * The first run realizes the subtask's own workspace from the project base,
 * exactly as it would for a top-level task.
 */
export function buildIndependentTaskWorkspaceSettings(
  raw: unknown,
): Record<string, unknown> | null {
  const settings = parseIssueExecutionWorkspaceSettings(raw, {
    includeEnvironmentId: true,
  });
  if (!settings) return null;
  // `operator_branch` works on a named existing branch, which for a subtask
  // would be the ancestor's branch; the project default applies instead.
  const mode =
    settings.mode &&
    settings.mode !== "inherit" &&
    settings.mode !== "reuse_existing" &&
    settings.mode !== "operator_branch"
      ? settings.mode
      : null;
  const next: Record<string, unknown> = {};
  if (mode) next.mode = mode;
  if (settings.environmentId !== undefined)
    next.environmentId = settings.environmentId;
  if (settings.workspaceRuntime)
    next.workspaceRuntime = settings.workspaceRuntime;
  const strategy = settings.workspaceStrategy;
  if (strategy) {
    next.workspaceStrategy = {
      type: strategy.type,
      ...(strategy.baseRef ? { baseRef: strategy.baseRef } : {}),
      ...(strategy.branchTemplate ? { branchTemplate: strategy.branchTemplate } : {}),
      ...(strategy.worktreeParentDir ? { worktreeParentDir: strategy.worktreeParentDir } : {}),
      ...(strategy.provisionCommand ? { provisionCommand: strategy.provisionCommand } : {}),
      ...(strategy.runtimeProvisionCommand
        ? { runtimeProvisionCommand: strategy.runtimeProvisionCommand }
        : {}),
      ...(strategy.teardownCommand ? { teardownCommand: strategy.teardownCommand } : {}),
    };
  }
  return Object.keys(next).length > 0 ? next : null;
}

/** Ids of `parentId` and every ancestor above it (company-scoped). */
export async function loadAncestorIssueIds(
  db: Pick<Db, "execute">,
  companyId: string,
  parentId: string | null | undefined,
): Promise<string[]> {
  if (!parentId) return [];
  const chain = await loadParentChain(db, companyId, parentId);
  return chain.map((row) => row.id);
}

/**
 * True when the execution workspace belongs to one of `ancestorIssueIds`:
 * an ancestor created it, or an ancestor is currently bound to it. Either way
 * a descendant bound to it would write into the ancestor's files.
 */
export async function isAncestorExecutionWorkspace(
  db: LineageReader,
  input: { companyId: string; executionWorkspaceId: string; ancestorIssueIds: string[] },
): Promise<boolean> {
  if (input.ancestorIssueIds.length === 0) return false;
  const [workspace] = await db
    .select({ sourceIssueId: executionWorkspaces.sourceIssueId })
    .from(executionWorkspaces)
    .where(and(
      eq(executionWorkspaces.companyId, input.companyId),
      eq(executionWorkspaces.id, input.executionWorkspaceId),
    ))
    .limit(1);
  if (workspace?.sourceIssueId && input.ancestorIssueIds.includes(workspace.sourceIssueId)) {
    return true;
  }
  const [boundAncestor] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      inArray(issues.id, input.ancestorIssueIds),
      eq(issues.executionWorkspaceId, input.executionWorkspaceId),
    ))
    .limit(1);
  return Boolean(boundAncestor);
}
