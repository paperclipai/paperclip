import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { withDirectoryPublicationLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { ensureSkillCacheDirectory, skillRunNeedsFilesSql } from "../skill-version-cache.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";

export const RUNTIME_ASSET_RETENTION_MS = 30 * 24 * 60 * 60_000;
const TOUCH_MS = 60 * 60_000;
const touched = new Map<string, number>();
const observers = new Set<() => void>();
const root = () => path.join(resolvePaperclipInstanceRoot(), "runtime-context-assets");
function paths(digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid runtime asset digest");
  return { bundle: path.join(root(), "bundles", digest), manifest: path.join(root(), "manifests", `${digest}.json`) };
}

/** Persist an hourly access lease, under the same filesystem lock as deletion.
 * Warm turns inside that lease add no I/O or database calls. The long grace also
 * protects the short interval between preparation and durable run pinning. */
export async function withRuntimeAssetUse<T>(digest: string, consume: (locked: boolean) => Promise<T>, mutation = false): Promise<T> {
  const target = paths(digest);
  const last = touched.get(target.manifest);
  const fresh = last !== undefined && Date.now() - last < TOUCH_MS;
  if (fresh && !mutation) return consume(false);
  await ensureSkillCacheDirectory(path.dirname(target.bundle), true);
  return withDirectoryPublicationLock(target.bundle, async () => {
    const result = await consume(true);
    if (!fresh && (await fs.lstat(target.manifest).catch(() => null))?.isFile()) {
      const now = Date.now();
      await fs.utimes(target.manifest, new Date(now), new Date(now));
      if (touched.size >= 4096) touched.delete(touched.keys().next().value!);
      touched.set(target.manifest, now);
      for (const wake of observers) wake();
    }
    return result;
  });
}

async function protectedAssets(db: Db): Promise<Set<string> | null> {
  const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    input: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.runtimeMode, "native"), skillRunNeedsFilesSql())).limit(1001);
  if (rows.length > 1000) return null;
  const pins = new Set<string>();
  for (const row of rows) {
    try {
      const input = parseNativeExecutionInput(row.input);
      if (input.binding.runId !== row.id || input.binding.companyId !== row.companyId || input.binding.agentId !== row.agentId) return null;
      if (!("runtimeContext" in input)) return null;
      for (const asset of [input.runtimeContext.instructions.bundle, ...input.runtimeContext.skills.map(skill => skill.bundle)]) pins.add(asset.digest);
    } catch { return null; } // An unfinished/legacy input cannot prove absence.
  }
  return pins;
}
export async function removeRuntimeAssetTree(directory: string) {
  const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe runtime asset directory");
  await fs.chmod(directory, 0o700);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeRuntimeAssetTree(path.join(directory, entry.name));
    else if (!entry.isFile()) throw new Error("Unsafe runtime asset entry");
  }
  await fs.rm(directory, { recursive: true });
}

export function runtimeAssetRetention(db: Db) {
  let next: number | null = null;
  async function tick(signal: AbortSignal) {
    next = null;
    const directory = path.join(root(), "manifests");
    try { await ensureSkillCacheDirectory(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const candidates: Array<{ digest: string; at: number }> = [];
    const seen = new Set<string>();
    const manifests = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    for (const entry of manifests) {
      signal.throwIfAborted();
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const stat = await fs.lstat(path.join(directory, entry.name)).catch(() => null);
      if (!stat?.isFile()) continue;
      seen.add(entry.name.slice(0, -5));
      const at = stat.mtimeMs + RUNTIME_ASSET_RETENTION_MS;
      if (at <= Date.now()) candidates.push({ digest: entry.name.slice(0, -5), at });
      else next = Math.min(next ?? Infinity, at);
    }
    // A crash between bundle rename and manifest publication can leave an
    // unreferenced bundle. The same age, lock and run-pin checks apply.
    const bundles = path.join(root(), "bundles");
    try {
      await ensureSkillCacheDirectory(bundles);
      for (const entry of await fs.readdir(bundles, { withFileTypes: true })) {
        signal.throwIfAborted();
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || seen.has(entry.name)) continue;
        const stat = await fs.lstat(path.join(bundles, entry.name)).catch(() => null);
        if (!stat?.isDirectory()) continue;
        const at = stat.mtimeMs + RUNTIME_ASSET_RETENTION_MS;
        if (at <= Date.now()) candidates.push({ digest: entry.name, at });
        else next = Math.min(next ?? Infinity, at);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!candidates.length) return; // No SQL merely to discover idle history.
    const pins = await protectedAssets(db);
    if (!pins) return; // Reconsider on the next asset use or startup, without polling.
    const eligible = candidates.filter(entry => !pins.has(entry.digest));
    for (const { digest } of eligible.slice(0, 32)) {
      signal.throwIfAborted();
      const target = paths(digest);
      await ensureSkillCacheDirectory(path.dirname(target.bundle), true);
      await withDirectoryPublicationLock(target.bundle, async () => {
        const stat = await fs.lstat(target.manifest).catch(() => null) ?? await fs.lstat(target.bundle).catch(() => null);
        if (!stat || (!stat.isFile() && !stat.isDirectory()) || stat.isSymbolicLink()) return;
        const at = stat.mtimeMs + RUNTIME_ASSET_RETENTION_MS;
        if (at > Date.now()) { next = Math.min(next ?? Infinity, at); return; }
        await removeRuntimeAssetTree(target.bundle);
        await fs.rm(target.manifest, { force: true });
        touched.delete(target.manifest);
      });
    }
    if (eligible.length > 32) next = Math.min(next ?? Infinity, Date.now() + 1_000);
  }
  function start(coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">) {
    let requested = 0, completed = -1;
    const worker = coordinator.register(DELIVERY_QUEUES.runtimeAssetRetention, {
      retryMs: 5_000, pausePassiveMaintenance: true,
      async run(signal) { const generation = requested; await tick(signal); completed = generation; },
      hasPending: async () => false,
      nextRunAt: () => requested !== completed ? Date.now() + 5_000 : next,
    });
    const wake = () => { requested++; worker.wake(); };
    observers.add(wake);
    return { ...worker, async stop() { observers.delete(wake); await worker.stop(); } };
  }
  return { tick, start, nextRunAt: () => next };
}
