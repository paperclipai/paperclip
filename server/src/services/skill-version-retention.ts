import { withSkillPackageReadScope } from "./skill-package-store.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import { agents, companies, companySkills, companySkillVersions, type Db } from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { noteSkillVersionCacheChange } from "./skill-version-retention-notifications.js";
import { logger } from "../middleware/logger.js";
import { allocatedBytes, ensureSkillCacheDirectory, hasRestorableSnapshot, lastUsedAt,
  protectedVersions, SkillCacheBusy, skillVersionCachePaths, touchSkillVersionCache,
  withSkillVersionCacheLock } from "./skill-version-cache.js";

/**
 * Retention for materialized skill version directories.
 *
 * `materializeVersionSnapshot` writes each selected skill version to
 * `<instance>/skills/<companyId>/__versions__/<skillId>/<versionId>/` from the
 * version row's stored file inventory. A directory is a cache: when it is
 * removed while its row survives, the next resolve writes it again. Nothing
 * removed these directories before, so they grew with every new version.
 *
 * The prune keeps a directory when it is the skill's current version, an agent
 * pins it, a non-terminal heartbeat run captured it, it is among the newest
 * versions of its skill (when configured), or it was materialized or reused within the grace
 * window. It removes every other version directory, directories whose version
 * or skill row is gone, and abandoned staging directories. Version rows are
 * never deleted here.
 */

export const SKILL_VERSION_RETENTION_DEFAULT_KEEP_NEWEST = 0;
export const SKILL_VERSION_RETENTION_DEFAULT_GRACE_MS = 60 * 60 * 1000;
export const SKILL_VERSION_RETENTION_DEFAULT_MAX_REMOVALS = 50;

const VERSIONS_DIR = "__versions__";
const TRASH_PREFIX = ".trash-";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUERY_BATCH = 500;

// In-process coordination between materialization and pruning, keyed by the
// absolute version directory. A materialization waits for a pending removal of
// its directory; a prune skips a directory that a materialization is writing.
const versionSnapshotFlights = new Map<string, Promise<string>>();
const versionSnapshotRemovals = new Map<string, Promise<unknown>>();
// Trash directories this process is deleting right now; a concurrent prune skips them.
const activeTrash = new Set<string>();

export function resolveCompanySkillVersionsRoot(companyId: string) {
  return path.resolve(resolvePaperclipInstanceRoot(), "skills", companyId, VERSIONS_DIR);
}

export function resolveSkillVersionSnapshotDir(companyId: string, skillId: string, versionId: string) {
  return path.join(resolveCompanySkillVersionsRoot(companyId), skillId, versionId);
}

/**
 * Runs one materialization per version directory at a time. Concurrent callers
 * share the in-flight promise. A pending prune of the same directory finishes
 * first, so a caller never receives a path that a prune is about to remove.
 */
export async function runVersionSnapshotFlight(skillDir: string, work: () => Promise<string>): Promise<string> {
  for (;;) {
    const removal = versionSnapshotRemovals.get(skillDir);
    if (!removal) break;
    await removal.catch(() => undefined);
  }
  const existing = versionSnapshotFlights.get(skillDir);
  if (existing) return existing;
  const startedAt = Date.now();
  const flight = work();
  versionSnapshotFlights.set(skillDir, flight);
  try { return await flight; } finally {
    if (versionSnapshotFlights.get(skillDir) === flight) versionSnapshotFlights.delete(skillDir);
    noteSkillVersionCacheChange(skillDir, { occurredAt: startedAt });
  }
}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code;
}

async function makeTreeWritable(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.chmod(target, 0o700).catch(() => undefined);
    const entries = await fs.readdir(target).catch(() => [] as string[]);
    for (const entry of entries) await makeTreeWritable(path.join(target, entry));
  } else {
    await fs.chmod(target, 0o600).catch(() => undefined);
  }
}

/**
 * Removes a snapshot tree. Snapshot files are read-only, and some platforms
 * refuse to unlink read-only entries, so a permission failure makes the tree
 * writable and retries. Symbolic links are removed, never followed.
 */
async function removeSnapshotTree(target: string) {
  if (activeTrash.has(target)) return;
  activeTrash.add(target);
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EACCES" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
    await makeTreeWritable(target);
    await fs.rm(target, { recursive: true, force: true });
  } finally {
    activeTrash.delete(target);
  }
}

/**
 * Moves a directory out of its readable name in one atomic rename under the
 * shared cache lock. Its unique trash name can be deleted after releasing it.
 */
async function removeVersionDirectory(parent: string, name: string): Promise<string | null> {
  const target = path.join(parent, name);
  if (path.dirname(target) !== parent) return null;
  if (versionSnapshotFlights.has(target) || versionSnapshotRemovals.has(target)) return null;
  const trash = path.join(parent, `${TRASH_PREFIX}${randomUUID()}`);
  const rename = fs.rename(target, trash);
  versionSnapshotRemovals.set(target, rename);
  try {
    await rename;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  } finally {
    versionSnapshotRemovals.delete(target);
  }
  return trash;
}

type CompanyCursor = { skillId: string; name: string };
export type SkillVersionRetentionCursor = CompanyCursor & { companyId: string };
export type SkillVersionPruneOptions = {
  keepNewest?: number;
  graceMs?: number;
  maxRemovals?: number;
  /** Bound inspection too, including protected directories. */
  maxEntries?: number;
  now?: Date;
  dryRun?: boolean;
  shouldContinue?: () => boolean;
};
export type SkillVersionPruneResult = {
  checked: number; candidates: number; candidateBytes: number; reclaimedBytes: number;
  removed: number; removedOrphans: number; removedStaging: number; kept: number;
  skippedRecent: number; failed: number; truncated: boolean;
  skipped: Record<string, number>;
  cursor: CompanyCursor | null;
  nextRunAt: number | null;
  interrupted: boolean;
};
function emptyResult(): SkillVersionPruneResult {
  return { checked: 0, candidates: 0, candidateBytes: 0, reclaimedBytes: 0,
    removed: 0, removedOrphans: 0, removedStaging: 0, kept: 0,
    skippedRecent: 0, failed: 0, truncated: false, skipped: {}, cursor: null, nextRunAt: null, interrupted: false };
}

type Candidate = { parent: string; skillId: string; name: string; unsafe?: boolean; discoveryOnly?: boolean };

// Retain directory handles between pages instead of re-reading/sorting N names
// for every 50-entry continuation. Every directory entry consumes a scan slot.
async function* discoverDirectories(root: string): AsyncGenerator<Candidate> {
  await ensureSkillCacheDirectory(root);
  const directory = await fs.opendir(root, { bufferSize: 1 });
  try {
    for (;;) {
      const entry = await directory.read();
      if (!entry) break;
      if (!UUID_PATTERN.test(entry.name)) {
        yield { parent: root, skillId: "", name: entry.name };
        continue;
      }
      const parent = path.join(root, entry.name);
      yield { parent, skillId: entry.name, name: "", discoveryOnly: true };
      let childDirectory;
      try {
        await ensureSkillCacheDirectory(parent);
        childDirectory = await fs.opendir(parent, { bufferSize: 1 });
      } catch {
        yield { parent, skillId: entry.name, name: "", unsafe: true };
        continue;
      }
      try {
        for (;;) {
          const child = await childDirectory.read();
          if (!child) break;
          yield { parent, skillId: entry.name, name: child.name };
        }
      } finally { await childDirectory.close(); }
    }
  } finally { await directory.close(); }
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

export function skillVersionRetentionService(db: Db, defaults: SkillVersionPruneOptions = {}) {
  const scans = new Map<string, { iterator: AsyncGenerator<Candidate>; cursor: CompanyCursor | null;
    pending: Candidate[]; expiry: ReturnType<typeof setTimeout> }>();
  const scanning = new Set<string>();
  async function closeScan(companyId: string) {
    const scan = scans.get(companyId);
    if (!scan) return;
    scans.delete(companyId);
    clearTimeout(scan.expiry);
    await scan.iterator.return(undefined);
  }
  async function dispose() { for (const id of [...scans.keys()]) await closeScan(id); }

  async function protectedVersionIds(companyId: string, skillIds: string[], keepNewest: number) {
    const keep = new Set<string>();
    const leaseDeadlines = new Map<string, number>();
    if (skillIds.length === 0) return { versions: keep, leaseDeadlines };
    for (const batch of chunks(skillIds, QUERY_BATCH)) {
      const rows = await db.select({ currentVersionId: companySkills.currentVersionId }).from(companySkills)
        .where(and(eq(companySkills.companyId, companyId), inArray(companySkills.id, batch)));
      for (const row of rows) if (row.currentVersionId) keep.add(row.currentVersionId);
      if (keepNewest > 0) {
        const ranked = db.select({
          id: companySkillVersions.id,
          rank: sql<number>`row_number() over (partition by ${companySkillVersions.companySkillId} order by ${companySkillVersions.revisionNumber} desc)`.as("rank"),
        }).from(companySkillVersions)
          .where(and(eq(companySkillVersions.companyId, companyId), inArray(companySkillVersions.companySkillId, batch)))
          .as("ranked");
        for (const row of await db.select({ id: ranked.id }).from(ranked).where(lte(ranked.rank, keepNewest))) keep.add(row.id);
      }
    }
    for (const agent of await db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.companyId, companyId))) {
      for (const entry of readPaperclipSkillSyncPreference(agent.adapterConfig ?? {}).desiredSkillEntries) {
        if (entry.versionId) keep.add(entry.versionId);
      }
    }
    const runVersions = await protectedVersions(db, companyId);
    if (!runVersions.versions) return { versions: null, leaseDeadlines };
    for (const [version, at] of runVersions.leaseDeadlines) if (!keep.has(version)) leaseDeadlines.set(version, at);
    for (const version of runVersions.versions) keep.add(version);
    return { versions: keep, leaseDeadlines };
  }

  async function pruneCompanyPage(companyId: string, options: SkillVersionPruneOptions & { cursor?: CompanyCursor | null } = {}): Promise<SkillVersionPruneResult> {
    if (!UUID_PATTERN.test(companyId)) throw new Error("Invalid company ID for skill retention");
    const keepNewest = Math.max(0, Math.floor(options.keepNewest ?? defaults.keepNewest ?? SKILL_VERSION_RETENTION_DEFAULT_KEEP_NEWEST));
    const graceMs = Math.max(0, options.graceMs ?? defaults.graceMs ?? SKILL_VERSION_RETENTION_DEFAULT_GRACE_MS);
    const maxRemovals = Math.min(50, Math.max(0, options.maxRemovals ?? defaults.maxRemovals ?? SKILL_VERSION_RETENTION_DEFAULT_MAX_REMOVALS));
    const maxEntries = Math.min(maxRemovals, Math.max(1, options.maxEntries ?? defaults.maxEntries ?? 50));
    const canContinue = options.shouldContinue ?? defaults.shouldContinue ?? (() => true);
    const dryRun = options.dryRun ?? defaults.dryRun ?? false;
    const now = (options.now ?? new Date()).getTime();
    const result = emptyResult();
    const shouldContinue = () => {
      const allowed = canContinue();
      if (!allowed) result.interrupted = true;
      return allowed;
    };
    const schedule = (at: number) => { result.nextRunAt = Math.min(result.nextRunAt ?? Infinity, at); };
    const skip = (reason: string) => {
      result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
      if (["cache_busy", "scan_busy", "unknown_run_pins", "unavailable_pins", "unsafe_or_unavailable", "cache_changed"].includes(reason)) schedule(now + 30_000);
    };
    const trash: string[] = [];
    const root = resolveCompanySkillVersionsRoot(companyId);
    const trashName = (name: string) => name.startsWith(TRASH_PREFIX) && UUID_PATTERN.test(name.slice(TRASH_PREFIX.length));
    let scan = scans.get(companyId);
    if (!options.cursor || !scan || scan.cursor?.skillId !== options.cursor.skillId || scan.cursor?.name !== options.cursor.name) {
      await closeScan(companyId);
      // A service normally holds two descriptors for one company's continuation.
      // Bound direct/internal callers too; abandoned cursors expire automatically.
      if (scans.size >= 16) await closeScan(scans.keys().next().value!);
      const expiry = setTimeout(() => { if (!scanning.has(companyId)) void closeScan(companyId).catch(() => {}); }, 5 * 60 * 1000);
      expiry.unref();
      scan = { iterator: discoverDirectories(root), cursor: null, pending: [], expiry };
      scans.set(companyId, scan);
    }
    scan.expiry.refresh();
    const entries: Candidate[] = [];
    let discoveryDone = false;
    try {
      while (entries.length < maxEntries && shouldContinue()) {
        const next = scan.pending.length ? { done: false, value: scan.pending.shift()! } : await scan.iterator.next();
        if (next.done) { discoveryDone = true; break; }
        entries.push(next.value);
      }
    } catch (error) {
      await closeScan(companyId);
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return result;
      result.checked++;
      result.failed++;
      skip("unsafe_or_unavailable");
      logger.warn({ err: error, companyId }, "skill version retention skipped unsafe company root");
      return result;
    }
    result.truncated = !discoveryDone;
    if (entries.length === 0) { await closeScan(companyId); return result; }
    const skillIds = [...new Set(entries.filter(entry => !entry.unsafe && entry.skillId).map(entry => entry.skillId))];
    let initialKeep: Awaited<ReturnType<typeof protectedVersionIds>>;
    try { initialKeep = await withSkillVersionCacheLock(db, companyId, () => protectedVersionIds(companyId, skillIds, keepNewest), true); }
    catch (error) {
      result.checked = 1;
      if (error instanceof SkillCacheBusy) skip("cache_busy");
      else { result.failed++; skip("unavailable_pins"); }
      await closeScan(companyId);
      result.truncated = false;
      return result;
    }
    if (!initialKeep.versions) { await closeScan(companyId); result.truncated = false; result.checked = 1; skip("unknown_run_pins"); return result; }
    const inspected: Array<{
      entry: Candidate; isStaging: boolean; version: boolean;
      before: { dev: number; ino: number }; bytes: number;
      eligible: (keep: Awaited<ReturnType<typeof protectedVersionIds>>) => Promise<{ dev: number; ino: number } | null>;
    }> = [];
    for (const entry of entries) {
      if (!shouldContinue()) { scan.pending.push(...entries.slice(result.checked)); result.truncated = true; break; }
      result.checked++;
      result.cursor = { skillId: entry.skillId, name: entry.name };
      if (entry.unsafe) { skip("unsafe_or_unavailable"); continue; }
      if (entry.discoveryOnly) continue;
      const target = path.join(entry.parent, entry.name);
      const isTrash = trashName(entry.name);
      const isVersion = UUID_PATTERN.test(entry.name);
      const isStaging = entry.name.startsWith(".") && UUID_PATTERN.test(entry.name.slice(1, 37))
        && /^-[a-zA-Z0-9]{6}$/.test(entry.name.slice(37));
      if (!isTrash && !isVersion && !isStaging) { skip("unknown_directory"); continue; }
      if (isTrash) { if (!dryRun) trash.push(target); continue; }
      // Called under the shared lock both before inspection and immediately
      // before rename. A preparation between these calls changes the pins/use.
      const eligible = async (keep: Awaited<ReturnType<typeof protectedVersionIds>>) => {
        if (!shouldContinue()) return null;
        await ensureSkillCacheDirectory(target);
        if (versionSnapshotFlights.has(target) || versionSnapshotRemovals.has(target)) { skip("cache_busy"); return null; }
        if (!keep.versions) { skip("unknown_run_pins"); return null; }
        if (isVersion && keep.versions.has(entry.name)) {
          const leaseDeadline = keep.leaseDeadlines.get(entry.name);
          if (leaseDeadline !== undefined) schedule(Math.max(now + 1000, leaseDeadline));
          result.kept++; skip("protected_version"); return null;
        }
        const stat = await fs.lstat(target);
        if (isVersion) {
          const used = await lastUsedAt(skillVersionCachePaths(companyId, entry.skillId, entry.name).access);
          if (used === null) {
            if (!dryRun) {
              await touchSkillVersionCache(companyId, entry.skillId, entry.name, now);
              schedule(now + graceMs);
            }
            skip("observation_grace"); return null;
          }
          if (now - used < graceMs) { schedule(used + graceMs); result.skippedRecent++; skip("recent_use"); return null; }
        } else if (now - stat.mtimeMs < graceMs) { schedule(stat.mtimeMs + graceMs); result.skippedRecent++; return null; }
        return stat;
      };
      try {
        const before = await withSkillVersionCacheLock(db, companyId, () => eligible(initialKeep), true);
        if (!before) continue;
        // Inventory transfer/validation and recursive file walks must not hold
        // the lock needed by agent preparation. Immutable snapshots can be
        // checked here; mutable current/run pins are checked again below.
        const [version] = isVersion ? await db.select({ id: companySkillVersions.id }).from(companySkillVersions).where(and(
          eq(companySkillVersions.companyId, companyId), eq(companySkillVersions.companySkillId, entry.skillId),
          eq(companySkillVersions.id, entry.name))) : [];
        if (version && !await hasRestorableSnapshot(db, companyId, version.id)) { skip("snapshot_unavailable"); continue; }
        const bytes = await allocatedBytes(target, shouldContinue);
        inspected.push({ entry, isStaging, version: Boolean(version), before, bytes, eligible });
      } catch (error) {
        if (!shouldContinue()) { result.truncated = true; break; }
        if (error instanceof SkillCacheBusy) skip("cache_busy");
        else if (errorCode(error) === "ENOENT") skip("not_materialized");
        else {
          result.failed++;
          skip("unsafe_or_unavailable");
          logger.warn({ err: error, companyId }, "skill version cache candidate skipped");
        }
      }
    }
    if (inspected.length && shouldContinue()) {
      try {
        // Read company-wide agent/run pins once per phase, not once per cache.
        // The lock keeps this final set authoritative through every rename.
        await withSkillVersionCacheLock(db, companyId, async () => {
          const keep = await protectedVersionIds(companyId, skillIds, keepNewest);
          for (const candidate of inspected) {
            if (!shouldContinue()) { result.truncated = true; break; }
            try {
              const current = await candidate.eligible(keep);
              if (!current) continue;
              if (current.dev !== candidate.before.dev || current.ino !== candidate.before.ino) { skip("cache_changed"); continue; }
              result.candidates++;
              result.candidateBytes += candidate.bytes;
              if (dryRun) continue;
              const renamed = await removeVersionDirectory(candidate.entry.parent, candidate.entry.name);
              if (!renamed) { schedule(now + 30_000); continue; }
              trash.push(renamed);
              result.removed++;
              if (candidate.isStaging) result.removedStaging++;
              else if (!candidate.version) result.removedOrphans++;
            } catch (error) {
              if (errorCode(error) === "ENOENT") { skip("not_materialized"); continue; }
              result.failed++; skip("unsafe_or_unavailable");
              logger.warn({ err: error, companyId }, "skill version cache rename skipped");
            }
          }
        }, true);
      } catch (error) {
        if (error instanceof SkillCacheBusy) skip("cache_busy");
        else { result.failed++; skip("unavailable_pins"); }
      }
    }
    if (!result.truncated) { result.cursor = null; await closeScan(companyId); }
    else scan.cursor = result.cursor;
    // These unique names are never reused by materialization. A crash leaves
    // them for the next scan; a returning run can rehydrate immediately.
    for (const target of trash) {
      if (!shouldContinue()) break;
      try {
        await withSkillVersionCacheLock(db, `trash:${companyId}:${target}`, async () => {
          await ensureSkillCacheDirectory(target);
          const bytes = await allocatedBytes(target, shouldContinue);
          if (!shouldContinue()) return;
          await removeSnapshotTree(target);
          result.reclaimedBytes += bytes;
        }, true);
      } catch (error) {
        if (!shouldContinue()) break;
        if (errorCode(error) === "ENOENT") continue;
        if (error instanceof SkillCacheBusy) { schedule(now + 30_000); continue; }
        result.failed++; schedule(now + 30_000);
        logger.warn({ err: error, companyId }, "skill version snapshot trash removal failed");
      }
    }
    return result;
  }

  async function pruneCompany(companyId: string, options: SkillVersionPruneOptions & { cursor?: CompanyCursor | null } = {}) {
    if (scanning.has(companyId)) return { ...emptyResult(), checked: 1, nextRunAt: Date.now() + 30_000, skipped: { scan_busy: 1 } };
    scanning.add(companyId);
    try { return await withSkillPackageReadScope(db, () => pruneCompanyPage(companyId, options)); }
    finally { scanning.delete(companyId); }
  }

  // A continuation visits later companies and protected directories too; a busy
  // first company or a dry run cannot starve the remainder of the instance.
  let cursor: SkillVersionRetentionCursor | null = null;
  async function tick(options: SkillVersionPruneOptions = {}) {
    const maxRemovals = Math.min(50, options.maxRemovals ?? defaults.maxRemovals ?? SKILL_VERSION_RETENTION_DEFAULT_MAX_REMOVALS);
    const maxEntries = Math.min(maxRemovals, options.maxEntries ?? defaults.maxEntries ?? 50);
    const shouldContinue = options.shouldContinue ?? defaults.shouldContinue ?? (() => true);
    const totals = { ...emptyResult(), companies: 0, cursor: null as SkillVersionRetentionCursor | null };
    const companyRows = await db.select({ id: companies.id }).from(companies)
      .where(cursor ? cursor.skillId === "\uffff" ? gt(companies.id, cursor.companyId) : gte(companies.id, cursor.companyId) : undefined)
      .orderBy(asc(companies.id)).limit(51);
    for (const company of companyRows) {
      if (cursor && (company.id < cursor.companyId || (company.id === cursor.companyId && cursor.skillId === "\uffff"))) continue;
      if (totals.companies >= 50 || totals.checked >= maxEntries || totals.candidates >= maxRemovals || !shouldContinue()) { totals.truncated = true; break; }
      const result = await pruneCompany(company.id, { ...options, cursor: cursor?.companyId === company.id ? cursor : null,
        maxEntries: maxEntries - totals.checked, maxRemovals: maxRemovals - totals.candidates, shouldContinue });
      totals.companies++;
      totals.interrupted ||= result.interrupted;
      if (result.nextRunAt !== null) totals.nextRunAt = Math.min(totals.nextRunAt ?? Infinity, result.nextRunAt);
      for (const key of ["checked", "candidates", "candidateBytes", "reclaimedBytes", "removed", "removedOrphans", "removedStaging", "kept", "skippedRecent", "failed"] as const) totals[key] += result[key];
      for (const [reason, count] of Object.entries(result.skipped)) totals.skipped[reason] = (totals.skipped[reason] ?? 0) + count;
      cursor = { companyId: company.id, skillId: "\uffff", name: "" };
      if (result.truncated) {
        cursor = { companyId: company.id, ...(result.cursor ?? { skillId: "", name: "" }) };
        totals.truncated = true;
        break;
      }
    }
    if (!totals.truncated) cursor = null;
    totals.cursor = cursor;
    return totals;
  }
  async function listCompanies(after?: string) {
    return db.select({ id: companies.id }).from(companies)
      .where(after ? gt(companies.id, after) : undefined).orderBy(asc(companies.id)).limit(51);
  }
  return { pruneCompany, tick, listCompanies, dispose, dryRun: defaults.dryRun ?? false,
    graceMs: Math.max(0, defaults.graceMs ?? SKILL_VERSION_RETENTION_DEFAULT_GRACE_MS) };
}
