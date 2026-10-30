import { skillPackageStore, skillVersionMetadataColumns } from "./skill-package-store.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { companySkillVersions, heartbeatRuns,
  nativeRunFinalizations, environmentLeases, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { assertSkillSnapshotPath } from "./skill-snapshot.js";
import { repositorySkillFrontmatter } from "./skill-repository-package.js";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { noteSkillVersionCacheChange } from "./skill-version-retention-notifications.js";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { beginRunPhase } from "./execution-preparation-timing.js";

export const SKILL_VERSION_CACHE_IDLE_MS = 60 * 60 * 1000;
const locks = new AsyncLocalStorage<Array<{ db: Db; companyId: string }>>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class SkillCacheBusy extends Error {}
/** Hold through publication AND durable run pinning, not just file creation. */
export async function withSkillVersionCacheLock<T>(db: Db, companyId: string, action: () => Promise<T>, tryOnly = false): Promise<T> {
  const held = locks.getStore() ?? [];
  if (held.some(lock => lock.db === db && lock.companyId === companyId)) return action();
  // Preparation uses the ordinary pool for version/pin writes. Borrowing a pool
  // connection for this lock would deadlock installations with a one-slot pool.
  const acquired = beginRunPhase("skills.cache.acquire");
  return withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
    const key = `skill_version_cache:${companyId}`;
    if (tryOnly) {
      const rows = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`);
      if (!rows[0]?.acquired) throw new SkillCacheBusy();
    } else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    acquired();
    return locks.run([...held, { db, companyId }], action);
  })).catch(error => {
    acquired(true);
    throw error;
  });
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
  const { access, directory } = skillVersionCachePaths(companyId, skillId, versionId);
  await ensureSkillCacheDirectory(path.dirname(access), true);
  const temporary = `${access}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, lastUsedAt: now }), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, access);
    noteSkillVersionCacheChange(directory, { source: "access", occurredAt: now });
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

export function skillRunNeedsFilesSql() {
  return sql`(
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
    )`;
}

// A terminal run can still own provider execution or recovery. Only fully settled
// runs release their pins; resume preparation reacquires the same cache lock.
export async function protectedVersions(db: Db, companyId: string): Promise<{ versions: Set<string> | null; leaseDeadlines: Map<string, number> }> {
  const rows = await db.select({
    id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, nativeIssueId: heartbeatRuns.nativeIssueId,
    leaseDeadline: sql<number | null>`case when ${heartbeatRuns.status} in ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')
      and ${heartbeatRuns.finishedAt} is not null and ${heartbeatRuns.controllerLeaseExpiresAt} > now()
      then extract(epoch from ${heartbeatRuns.controllerLeaseExpiresAt}) * 1000 end`,
    pins: sql<unknown>`${heartbeatRuns.contextSnapshot}->'skillVersions'`,
    // Avoid loading large execution inputs for runs with the modern pin map.
    legacyInput: sql<unknown>`case when ${heartbeatRuns.runtimeMode} = 'native'
      and not coalesce(${heartbeatRuns.contextSnapshot} ? 'skillVersions', false)
      then ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput' end`,
  })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), skillRunNeedsFilesSql()));
  const versions = new Set<string>();
  const leaseDeadlines = new Map<string, number>();
  const unknown = () => ({ versions: null, leaseDeadlines });
  for (const { pins, legacyInput, id, agentId, nativeIssueId, leaseDeadline } of rows) {
    const add = (version: string) => {
      versions.add(version);
      if (leaseDeadline !== null) leaseDeadlines.set(version, Math.min(leaseDeadlines.get(version) ?? Infinity, Number(leaseDeadline)));
    };
    if (legacyInput != null) {
      // Older native runs captured the complete selection in their immutable
      // execution input before contextSnapshot.skillVersions was introduced.
      // Use the recovery parser (including digest validation) and the exact run
      // binding. Never repair a malformed modern pin map with a different source.
      try {
        const input = parseNativeExecutionInput(legacyInput);
        if (!("runtimeContext" in input) || input.binding.companyId !== companyId
          || input.binding.runId !== id || input.binding.agentId !== agentId
          || input.binding.issueId !== nativeIssueId) return unknown();
        for (const skill of input.runtimeContext.skills) {
          // Unversioned skills have their own captured asset bundle; they do
          // not reference a directory under __versions__.
          if (skill.versionId === null) continue;
          if (!uuid.test(skill.versionId)) return unknown();
          add(skill.versionId);
        }
        continue;
      } catch { return unknown(); }
    }
    // Legacy/incomplete preparation is not proof that no skill is in use.
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) return unknown();
    for (const version of Object.values(pins)) {
      if (typeof version !== "string" || !uuid.test(version)) return unknown();
      add(version);
    }
  }
  return { versions, leaseDeadlines };
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
  const [version] = await db.select(skillVersionMetadataColumns).from(companySkillVersions).where(and(
    eq(companySkillVersions.companyId, companyId), eq(companySkillVersions.id, versionId)));
  if (!version) return false;
  const packageId = version.repositorySnapshotId ?? version.packageSnapshotId;
  const store = skillPackageStore(db);
  if (packageId) {
    if (version.repositorySnapshotId && !version.repositorySkillPath) return false;
    const manifest = await store.manifest(companyId, packageId);
    const entrypoint = version.repositorySkillPath ?? version.packageFileMap?.find(file => file.path === "SKILL.md")?.sourcePath ?? "SKILL.md";
    const entry = manifest.files.find(file => file.path === entrypoint);
    if (!entry) return false;
    // Git packages intentionally permit byte eviction. Their immutable recipe,
    // not a network probe during cleanup, is the restoration contract.
    if ((await store.descriptor(companyId, packageId)).restorable) return true;
    if (version.repositorySnapshotId && entry.encoding === "base64") return false;
    // Validate original frontmatter inside the same isolated storage verification,
    // outside the preparation lock and without rebuilding the shared cache.
    return store.verifyDurable(companyId, packageId, undefined, version.repositorySnapshotId
      ? async root => Boolean(repositorySkillFrontmatter(await fs.readFile(path.join(root, entrypoint), "utf8"))) : undefined);
  }
  const files = await store.versionFiles(version);
  return validateInventory(files) && files.some(file => file.path === "SKILL.md");
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

