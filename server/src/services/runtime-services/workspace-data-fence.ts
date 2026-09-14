import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { executionWorkspaces, runtimeServiceAllocations, runtimeServiceDataDeletions, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";

type Reader = Pick<Db, "select" | "execute">;
const admissionKey = "runtime-service-task-data-admission";
export async function lockTaskWorkspaceDataAdmission(reader: Reader) {
  await reader.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${admissionKey}))`);
}
export async function tryLockTaskWorkspaceDataDeletion(reader: Reader) {
  const rows = await reader.execute(sql`select pg_try_advisory_xact_lock(hashtext(${admissionKey})) as acquired`);
  if (!rows[0]?.acquired) throw conflict("Workspace preparation is in progress. Refresh the data deletion review and retry.");
}
export function taskWorkspacePathsOverlap(first: string, second: string) {
  const contains = (root: string, child: string) => {
    const relative = path.relative(root, child);
    return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return contains(first, second) || contains(second, first);
}
// Resolve existing ancestors too: a removed child beneath a symlink must keep
// the same physical fence while cleanup is between rename and completion.
async function canonicalLocalPath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(absolute) === absolute) throw error;
    return path.join(await canonicalLocalPath(path.dirname(absolute)), path.basename(absolute));
  }
}
export async function assertLocalPathDataAvailable(reader: Reader, cwd: string) {
  const canonical = await canonicalLocalPath(cwd);
  // A different company/workspace ID must not bypass a pending physical-path
  // deletion. Completed jobs permit a new workspace with new files at that path.
  const jobs = await reader.select({ id: runtimeServiceDataDeletions.id, target: runtimeServiceDataDeletions.target }).from(runtimeServiceDataDeletions)
    .where(and(ne(runtimeServiceDataDeletions.state, "deleted"), sql`${runtimeServiceDataDeletions.target}->>'kind' in ('local_task_workspace', 'task_workspace')`));
  for (const { id, target } of jobs) {
    const root = (target.filesystem as { root?: { path?: unknown } } | undefined)?.root?.path;
    const quarantine = typeof root === "string" && typeof target.workspaceId === "string"
      ? path.join(path.dirname(root), ".paperclip-service-deletions", id, target.workspaceId) : null;
    if ((typeof root === "string" && taskWorkspacePathsOverlap(root, canonical)) || (quarantine && taskWorkspacePathsOverlap(quarantine, canonical))) throw conflict("This task workspace is being deleted; choose another workspace or wait for cleanup to finish");
  }
}
export async function assertTaskWorkspaceDataAvailable(reader: Reader, companyId: string, workspaceId: string) {
  const [fenced] = await reader.select({ id: runtimeServiceAllocations.id }).from(runtimeServiceAllocations)
    .where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.executionWorkspaceId, workspaceId), isNotNull(runtimeServiceAllocations.dataDeletionId))).limit(1);
  if (fenced) throw conflict("This task workspace's data is being deleted or has been deleted. Choose a new workspace to continue.");
  const [workspace] = await reader.select({ cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef }).from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, workspaceId)));
  for (const cwd of new Set([workspace?.cwd, workspace?.providerRef])) if (cwd && path.isAbsolute(cwd)) await assertLocalPathDataAvailable(reader, cwd);
}
type AdmissionGroup = { active: number; ready: Promise<Reader>; finished: Promise<void>; release: () => void };
const admissionGroups = new WeakMap<Db, AdmissionGroup>();
function sharedAdmission(db: Db): AdmissionGroup {
  const existing = admissionGroups.get(db);
  if (existing) { existing.active += 1; return existing; }
  let release!: () => void, ready!: (reader: Reader) => void, reject!: (error: unknown) => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const available = new Promise<Reader>((resolve, fail) => { ready = resolve; reject = fail; });
  const finished = db.transaction(async (tx) => {
    await lockTaskWorkspaceDataAdmission(tx);
    ready(tx);
    await held;
  });
  // Concurrent preparations share one lock connection, leaving the pool free
  // for their actual work. One connection per preparation can exhaust the pool
  // before any of those preparations can publish a run or service record.
  void finished.catch(reject);
  const group = { active: 1, ready: available, finished, release };
  admissionGroups.set(db, group);
  return group;
}
export async function withTaskWorkspaceDataAdmission<T>(db: Db, companyId: string, workspaceId: string | null | undefined, work: () => Promise<T>, cwd?: string | null) {
  if (!workspaceId && !cwd) return work();
  const group = sharedAdmission(db);
  try {
    const reader = await group.ready;
    if (workspaceId) await assertTaskWorkspaceDataAvailable(reader, companyId, workspaceId);
    if (cwd) await assertLocalPathDataAvailable(reader, cwd);
    return await work();
  } finally {
    group.active -= 1;
    if (!group.active) {
      admissionGroups.delete(db);
      group.release();
      await group.finished;
    }
  }
}
