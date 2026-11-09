import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { companySkillVersions, companySkillRepositorySnapshots, heartbeatRuns,
  nativeRunFinalizations, environmentLeases, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { assertSkillSnapshotPath } from "./skill-snapshot.js";
import { repositorySkillFrontmatter } from "./skill-repository-package.js";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";

export const SKILL_VERSION_CACHE_IDLE_MS = 60 * 60 * 1000;
const locks = new AsyncLocalStorage<Array<{ db: Db; companyId: string }>>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class SkillCacheBusy extends Error {}
// Repository snapshots are immutable and referenced with restrictive foreign
// keys. Cache only validated entrypoint names, never large file contents, so an
// hourly sweep does not transfer the same repository for each skill/version.
const verifiedSnapshots = new WeakMap<Db, Map<string, ReadonlySet<string>>>();

/** Hold through publication AND durable run pinning, not just file creation. */
export async function withSkillVersionCacheLock<T>(db: Db, companyId: string, action: () => Promise<T>, tryOnly = false): Promise<T> {
  const held = locks.getStore() ?? [];
  if (held.some(lock => lock.db === db && lock.companyId === companyId)) return action();
  // Preparation uses the ordinary pool for version/pin writes. Borrowing a pool
  // connection for this lock would deadlock installations with a one-slot pool.
  return withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
    const key = `skill_version_cache:${companyId}`;
    if (tryOnly) {
      const rows = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`);
      if (!rows[0]?.acquired) throw new SkillCacheBusy();
    } else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return locks.run([...held, { db, companyId }], action);
  }));
}

export function skillVersionCachePaths(companyId: string, skillId: string, versionId: string) {
  if (![companyId, skillId, versionId].every(value => uuid.test(value))) throw new Error("Invalid skill cache identity");
  const root = path.join(resolvePaperclipInstanceRoot(), "skills", companyId);
  return {
    root,
    directory: path.join(root, "__versions__", skillId, versionId),
    access: path.join(root, "__version_access__", skillId, `${versionId}.json`),
  };
}

/** Never traverse a symlink below the configured instance root. */
export async function ensureSkillCacheDirectory(directory: string, create = false) {
  const root = path.resolve(resolvePaperclipInstanceRoot());
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Skill cache escaped instance root");
  if (create) await fs.mkdir(root, { recursive: true });
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (create) await fs.mkdir(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe skill cache directory");
  }
}

export async function touchSkillVersionCache(companyId: string, skillId: string, versionId: string, now = Date.now()) {
  const { access } = skillVersionCachePaths(companyId, skillId, versionId);
  await ensureSkillCacheDirectory(path.dirname(access), true);
  const temporary = `${access}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, lastUsedAt: now }), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, access);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function lastUsedAt(filename: string): Promise<number | null> {
  try {
    await ensureSkillCacheDirectory(path.dirname(filename));
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 256) return null;
      const value = JSON.parse(await file.readFile("utf8"));
      return value.version === 1 && Number.isSafeInteger(value.lastUsedAt) && value.lastUsedAt > 0 ? value.lastUsedAt : null;
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof SyntaxError || ["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

// A terminal run can still own provider execution or recovery. Only fully settled
// runs release their pins; resume preparation reacquires the same cache lock.
export async function protectedVersions(db: Db, companyId: string): Promise<Set<string> | null> {
  const rows = await db.select({
    id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, nativeIssueId: heartbeatRuns.nativeIssueId,
    pins: sql<unknown>`${heartbeatRuns.contextSnapshot}->'skillVersions'`,
    // Avoid loading large execution inputs for runs with the modern pin map.
    legacyInput: sql<unknown>`case when ${heartbeatRuns.runtimeMode} = 'native'
      and not coalesce(${heartbeatRuns.contextSnapshot} ? 'skillVersions', false)
      then ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput' end`,
  })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), sql`(
      ${heartbeatRuns.status} not in ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')
      or ${heartbeatRuns.finishedAt} is null
      or ${heartbeatRuns.controllerLeaseExpiresAt} > now()
      or exists (select 1 from ${nativeRunFinalizations} f
        where f.company_id = ${heartbeatRuns.companyId} and f.run_id = ${heartbeatRuns.id}
        and (f.phase <> 'committed' or f.lease_owner is not null or f.recovery_state is not null))
      or exists (select 1 from ${environmentLeases} l
        where l.company_id = ${heartbeatRuns.companyId} and l.heartbeat_run_id = ${heartbeatRuns.id}
        and (l.status = 'pending_cleanup' or l.cleanup_status = 'failed'
          or l.metadata ? 'nativeWorkspaceExportResume'
          or (l.released_at is null and not coalesce(l.status = 'retained'
            and l.lease_policy = 'reuse_by_environment' and l.cleanup_status = 'success', false))))
    )`));
  const versions = new Set<string>();
  for (const { pins, legacyInput, id, agentId, nativeIssueId } of rows) {
    if (legacyInput != null) {
      // Older native runs captured the complete selection in their immutable
      // execution input before contextSnapshot.skillVersions was introduced.
      // Use the recovery parser (including digest validation) and the exact run
      // binding. Never repair a malformed modern pin map with a different source.
      try {
        const input = parseNativeExecutionInput(legacyInput);
        if (!("runtimeContext" in input) || input.binding.companyId !== companyId
          || input.binding.runId !== id || input.binding.agentId !== agentId
          || input.binding.issueId !== nativeIssueId) return null;
        for (const skill of input.runtimeContext.skills) {
          // Unversioned skills have their own captured asset bundle; they do
          // not reference a directory under __versions__.
          if (skill.versionId === null) continue;
          if (!uuid.test(skill.versionId)) return null;
          versions.add(skill.versionId);
        }
        continue;
      } catch { return null; }
    }
    // Legacy/incomplete preparation is not proof that no skill is in use.
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) return null;
    for (const version of Object.values(pins)) {
      if (typeof version !== "string" || !uuid.test(version)) return null;
      versions.add(version);
    }
  }
  return versions;
}

function validateInventory(inventory: CompanySkillVersionFileInventoryEntry[]) {
  const seen = new Set<string>();
  for (const file of inventory) {
    assertSkillSnapshotPath(file.path);
    if (seen.has(file.path) || typeof file.content !== "string") return false;
    seen.add(file.path);
  }
  return true;
}

export async function hasRestorableSnapshot(db: Db, companyId: string, versionId: string) {
  const [version] = await db.select().from(companySkillVersions).where(and(
    eq(companySkillVersions.companyId, companyId), eq(companySkillVersions.id, versionId)));
  if (!version) return false;
  if (version.repositorySnapshotId) {
    if (!version.repositorySkillPath) return false;
    let cache = verifiedSnapshots.get(db);
    if (!cache) { cache = new Map(); verifiedSnapshots.set(db, cache); }
    const key = `${companyId}:${version.repositorySnapshotId}`;
    const verified = cache.get(key);
    if (verified) return verified.has(version.repositorySkillPath);
    const [snapshot] = await db.select({ inventory: companySkillRepositorySnapshots.fileInventory })
      .from(companySkillRepositorySnapshots).where(and(eq(companySkillRepositorySnapshots.companyId, companyId),
        eq(companySkillRepositorySnapshots.id, version.repositorySnapshotId)));
    if (!snapshot || !validateInventory(snapshot.inventory)) return false;
    const entrypoints = new Set(snapshot.inventory.filter(file => file.encoding !== "base64"
      && repositorySkillFrontmatter(file.content)).map(file => file.path));
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, entrypoints);
    return entrypoints.has(version.repositorySkillPath);
  }
  return validateInventory(version.fileInventory) && version.fileInventory.some(file => file.path === "SKILL.md");
}

// Counts allocated bytes without following links, matching what df can reclaim.
export async function allocatedBytes(directory: string, shouldContinue: () => boolean = () => true): Promise<number> {
  if (!shouldContinue()) throw new Error("Skill cache scan stopped");
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Unsafe skill cache entry");
  let bytes = stat.blocks * 512;
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(directory)) bytes += await allocatedBytes(path.join(directory, entry), shouldContinue);
  }
  return bytes;
}

