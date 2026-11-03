import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, workspaceOperations, type Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";

type ReadDb = Pick<Db, "select">;
type Workspace = typeof executionWorkspaces.$inferSelect;
export type ImportedWorkspaceChild = {
  workspaceId: string; snapshotId: string; operationId: string; relativePath: string; manifestDigest: string;
};
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const rootOf = (workspace: Pick<Workspace, "cwd" | "providerRef">) => workspace.cwd ?? workspace.providerRef;

export async function offlineWorkspaceMigrationBlockers(db: ReadDb) {
  if (process.env.PAPERCLIP_EPHEMERAL_MIGRATION !== "true") return ["offline_maintenance_required"];
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, ["running", "queued"])).limit(1);
  return active ? ["active_execution_requires_drain"] : [];
}

/** Only the maintenance entry point can acknowledge that every old deployment
 * has stopped. A task-level migration hold cannot fence other path aliases. */
export async function workspaceMigrationLayoutBlockers(db: ReadDb, workspace: Workspace, writersStopped = false) {
  if (writersStopped) return offlineWorkspaceMigrationBlockers(db);
  const cwd = rootOf(workspace);
  if (!cwd) return [];
  const local = await db.select({ id: executionWorkspaces.id, cwd: executionWorkspaces.cwd,
    providerRef: executionWorkspaces.providerRef }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, workspace.companyId), ne(executionWorkspaces.id, workspace.id),
    inArray(executionWorkspaces.providerType, ["local_fs", "git_worktree"]),
  ));
  if (local.some(row => rootOf(row) && overlaps(path.resolve(cwd), path.resolve(rootOf(row)!)))) {
    return ["overlapping_workspace_requires_maintenance"];
  }
  const migrated = await db.select({ cwd: workspaceOperations.cwd }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.phase, "remote_workspace_migration"),
    eq(workspaceOperations.status, "succeeded"), ne(workspaceOperations.executionWorkspaceId, workspace.id),
  ));
  return migrated.some(row => row.cwd && path.resolve(row.cwd).startsWith(`${path.resolve(cwd)}/.paperclip/worktrees/`))
    ? ["overlapping_workspace_requires_maintenance"] : [];
}

/** Runtime-created nested task folders can be omitted only after an exact
 * committed import covers their current bytes. Ordinary user folders stay in
 * the parent archive. The snapshot owner retains the resulting dependencies. */
export async function prepareNestedWorkspaceImports(input: {
  db: Db; storage: StorageService; workspace: Workspace; scratch: string; signal?: AbortSignal;
}): Promise<ImportedWorkspaceChild[]> {
  const root = rootOf(input.workspace);
  if (!root) return [];
  const rows = await input.db.select({ operation: workspaceOperations, snapshot: executionWorkspaceSnapshots })
    .from(workspaceOperations).innerJoin(executionWorkspaceSnapshots, and(
      eq(executionWorkspaceSnapshots.companyId, workspaceOperations.companyId),
      eq(executionWorkspaceSnapshots.executionWorkspaceId, workspaceOperations.executionWorkspaceId),
      eq(executionWorkspaceSnapshots.sourceOperationId, workspaceOperations.id),
    )).where(and(eq(workspaceOperations.companyId, input.workspace.companyId),
      ne(workspaceOperations.executionWorkspaceId, input.workspace.id), eq(workspaceOperations.phase, "remote_workspace_migration"),
      eq(workspaceOperations.status, "succeeded"), inArray(executionWorkspaceSnapshots.status, ["committed", "superseded"]),
      sql`${workspaceOperations.metadata}->>'snapshotId' = ${executionWorkspaceSnapshots.id}::text`,
    ));
  const candidates = rows.filter(row => row.operation.cwd && path.resolve(row.operation.cwd).startsWith(`${path.resolve(root)}/.paperclip/worktrees/`))
    .sort((a, b) => a.operation.cwd!.length - b.operation.cwd!.length || a.operation.id.localeCompare(b.operation.id));
  const covered: ImportedWorkspaceChild[] = [];
  for (const { operation, snapshot } of candidates) {
    input.signal?.throwIfAborted();
    const relativePath = path.relative(root, operation.cwd!).split(path.sep).join("/");
    if (covered.some(item => relativePath === item.relativePath || relativePath.startsWith(`${item.relativePath}/`))) continue;
    const entry = await fs.lstat(operation.cwd!).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!entry) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("nested_workspace_source_changed");
    await verifyCoveredWorkspace({ ...input, sourcePath: operation.cwd!, snapshot, operationId: operation.id,
      expectedDigest: operation.metadata?.manifestDigest, depth: 0 });
    covered.push({ workspaceId: snapshot.executionWorkspaceId, snapshotId: snapshot.id, operationId: operation.id,
      relativePath, manifestDigest: snapshot.manifestDigest! });
  }
  return covered;
}

async function verifyCoveredWorkspace(input: {
  db: Db; storage: StorageService; sourcePath: string; snapshot: typeof executionWorkspaceSnapshots.$inferSelect;
  operationId: string; expectedDigest: unknown; scratch: string; signal?: AbortSignal; depth: number;
}) {
  input.signal?.throwIfAborted();
  if (input.depth > 32) throw new Error("nested_workspace_coverage_invalid");
  const { snapshot } = input;
  const reference = await getWorkspaceSnapshot(input.db, { companyId: snapshot.companyId,
    workspaceId: snapshot.executionWorkspaceId, snapshotId: snapshot.id });
  if (!reference || reference.manifestDigest !== input.expectedDigest || snapshot.sourceOperationId !== input.operationId)
    throw new Error("nested_workspace_snapshot_changed");
  const raw = snapshot.metadata?.importedWorkspaceChildren;
  if (raw !== undefined && (!Array.isArray(raw) || raw.some(child => !child || typeof child !== "object"
    || typeof child.relativePath !== "string" || !child.relativePath.startsWith(".paperclip/worktrees/")
    || child.relativePath.split("/").some((part: string) => !part || part === "." || part === "..")
    || !/^[a-f0-9-]{36}$/.test(child.workspaceId) || !/^[a-f0-9-]{36}$/.test(child.snapshotId)
    || !/^[a-f0-9-]{36}$/.test(child.operationId) || !/^[a-f0-9]{64}$/.test(child.manifestDigest)))) {
    throw new Error("nested_workspace_coverage_invalid");
  }
  const children = (raw ?? []) as ImportedWorkspaceChild[];
  const area = await fs.mkdtemp(path.join(input.scratch, "covered-"));
  for (const child of children) {
    const [saved] = await input.db.select({ operation: workspaceOperations, snapshot: executionWorkspaceSnapshots })
      .from(executionWorkspaceSnapshots).innerJoin(workspaceOperations, and(
        eq(workspaceOperations.companyId, executionWorkspaceSnapshots.companyId), eq(workspaceOperations.id, executionWorkspaceSnapshots.sourceOperationId),
      )).where(and(eq(executionWorkspaceSnapshots.companyId, snapshot.companyId), eq(executionWorkspaceSnapshots.id, child.snapshotId),
        eq(executionWorkspaceSnapshots.executionWorkspaceId, child.workspaceId), eq(workspaceOperations.id, child.operationId),
        eq(workspaceOperations.status, "succeeded"), eq(workspaceOperations.phase, "remote_workspace_migration"),
        inArray(executionWorkspaceSnapshots.status, ["committed", "superseded"])));
    const sourcePath = path.join(input.sourcePath, child.relativePath);
    if (!saved || saved.operation.cwd !== sourcePath) throw new Error("nested_workspace_coverage_invalid");
    await verifyCoveredWorkspace({ ...input, sourcePath, snapshot: saved.snapshot, operationId: child.operationId,
      expectedDigest: child.manifestDigest, scratch: area, depth: input.depth + 1 });
  }
  const archivePath = path.join(area, "saved.pcws"), restored = path.join(area, "restored");
  await loadWorkspaceSnapshotArchive({ storage: input.storage, reference, targetPath: archivePath, signal: input.signal });
  await restoreRemoteWorkspaceArchive({ archivePath, targetDir: restored, expectedManifestDigest: reference.manifestDigest, signal: input.signal });
  const current = await captureRemoteWorkspaceDirectory({ cwd: input.sourcePath, archivePath: path.join(area, "current.pcws"),
    exclude: children.map(child => child.relativePath), signal: input.signal });
  if (current.manifestDigest !== reference.manifestDigest) throw new Error("nested_workspace_source_changed");
}
