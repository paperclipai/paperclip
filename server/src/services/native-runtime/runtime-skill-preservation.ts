import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { heartbeatRuns, companySkillRepositorySnapshots as snapshots, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import type { StorageService } from "../../storage/types.js";
import { skillPackageStore, withSkillPackageReadScope } from "../skill-package-store.js";
import { assertSkillSnapshotPath, snapshotFile, skillSnapshotHash } from "../skill-snapshot.js";
import { ensureSkillCacheDirectory, skillRunNeedsFilesSql } from "../skill-version-cache.js";
import { verifyFileManifest } from "../file-manifest-cache.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { withRuntimeAssetUse } from "./runtime-asset-retention.js";
import { admittedRuntimeSkills, hasUnversionedRuntimeSkillInputSql, readRuntimeSkillPreservation,
  RUNTIME_SKILL_PRESERVATION_KEY, RUNTIME_SKILL_PRESERVATION_SCHEMA, sameRuntimeSkill,
  type PreservedRuntimeSkill } from "./runtime-skill-preservation-reference.js";
import type { NativeRuntimeAssetReference, NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const retainedRuntimeSkillsSql = () => and(hasUnversionedRuntimeSkillInputSql(), or(skillRunNeedsFilesSql(),
  sql`exists (select 1 from agent_task_sessions s where s.company_id = ${heartbeatRuns.companyId}
    and s.agent_id = ${heartbeatRuns.agentId} and s.last_run_id = ${heartbeatRuns.id})`));
type ManifestFile = { path: string; sha256: string; mode: number; size: number };
function manifestFiles(asset: NativeRuntimeAssetReference, text: string): ManifestFile[] {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024 || hash(text) !== asset.manifestDigest) throw new Error("runtime_skill_manifest_digest_mismatch");
  const manifest = JSON.parse(text);
  if (manifest.schema !== "paperclip.runtime-asset-manifest.v1" || manifest.digest !== asset.digest
    || manifest.fileCount !== asset.fileCount || manifest.totalBytes !== asset.totalBytes
    || !Array.isArray(manifest.files) || manifest.files.length !== asset.fileCount
    || manifest.files.length > 10_000 || asset.totalBytes > 64 * 1024 * 1024) throw new Error("runtime_skill_manifest_invalid");
  const files: ManifestFile[] = manifest.files;
  const seen = new Set<string>();
  for (const file of files) {
    assertSkillSnapshotPath(file.path);
    if (seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0
      || !Number.isInteger(file.mode) || file.mode < 0 || (file.mode & ~0o555) !== 0) throw new Error("runtime_skill_manifest_invalid");
    seen.add(file.path);
  }
  if (hash(JSON.stringify(files)) !== asset.digest || files.reduce((n, f) => n + f.size, 0) !== asset.totalBytes) throw new Error("runtime_skill_manifest_invalid");
  return files;
}
async function readSource(asset: NativeRuntimeAssetReference) {
  const root = path.join(resolvePaperclipInstanceRoot(), "runtime-context-assets");
  const expected = path.join(root, "bundles", asset.digest);
  if (asset.rootPath !== expected) throw new Error("runtime_skill_source_path_mismatch");
  await ensureSkillCacheDirectory(expected);
  await ensureSkillCacheDirectory(path.join(root, "manifests"));
  const handle = await fs.open(path.join(root, "manifests", `${asset.digest}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error("runtime_skill_manifest_invalid");
    text = await handle.readFile("utf8");
  } finally { await handle.close(); }
  const entries = manifestFiles(asset, text);
  if (!await verifyFileManifest(expected, entries.map(f => ({ ...f, executable: Boolean(f.mode & 0o111) })))) throw new Error("runtime_skill_source_changed");
  const files = [];
  for (const entry of entries) {
    const handle = await fs.open(path.join(expected, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size || (stat.mode & 0o777) !== entry.mode) throw new Error("runtime_skill_source_changed");
      const bytes = await handle.readFile();
      if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error("runtime_skill_source_changed");
      files.push(snapshotFile(entry.path, entry.path === "SKILL.md" ? "skill" : "other", bytes, Boolean(entry.mode & 0o111)));
    } finally { await handle.close(); }
  }
  return { manifestText: text, files };
}

/** Copy immutable admitted assets, never resolve a run's business/recovery state
 * or infer that its provider stopped. Local source bytes and null pins survive. */
export async function preserveRuntimeSkillAssets(db: Db, input: { companyId: string; runId: string; signal?: AbortSignal }, storage?: StorageService) {
  const where = and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId));
  const [source] = await db.select().from(heartbeatRuns).where(where);
  if (!source || source.runtimeMode !== "native") throw new Error("runtime_skill_source_unavailable");
  const admitted = admittedRuntimeSkills(source);
  const store = skillPackageStore(db, storage);
  const existing = readRuntimeSkillPreservation(source);
  if (source.runnerProfileJson?.[RUNTIME_SKILL_PRESERVATION_KEY] != null && !existing) throw new Error("runtime_skill_preservation_receipt_invalid");
  if (existing) {
    for (const asset of existing.assets) {
      manifestFiles(asset.bundle, asset.manifestText);
      const row = await store.descriptor(input.companyId, asset.packageSnapshotId);
      if (row.storage?.provider !== "s3" || row.contentHash !== asset.packageContentHash
        || !await store.verifyDurable(input.companyId, asset.packageSnapshotId, input.signal)) throw new Error("runtime_skill_package_not_durable");
    }
    return { preserved: existing.assets.length };
  }
  const assets: PreservedRuntimeSkill[] = [];
  for (const skill of admitted.skills) {
    input.signal?.throwIfAborted();
    const captured = await withRuntimeAssetUse(skill.bundle.digest, () => readSource(skill.bundle), true);
    const packageSnapshotId = await store.prepare(input.companyId, captured.files, true, input.signal);
    if (!await store.verifyDurable(input.companyId, packageSnapshotId, input.signal)) throw new Error("runtime_skill_package_not_durable");
    assets.push({ key: skill.key, runtimeName: skill.runtimeName, bundle: skill.bundle, manifestText: captured.manifestText,
      packageSnapshotId, packageContentHash: skillSnapshotHash(captured.files) });
  }
  if (!assets.length) return { preserved: 0 };
  const publications: ActivityPublication[] = [];
  await db.transaction(async tx => {
    const [current] = await tx.select().from(heartbeatRuns).where(where).for("update");
    if (!current || admittedRuntimeSkills(current).inputDigest !== admitted.inputDigest || current.status !== source.status
      || current.finishedAt?.getTime() !== source.finishedAt?.getTime()) throw new Error("runtime_skill_preservation_binding_changed");
    // Collector takes these same row locks before a fresh reference check. If
    // deletion won, publication fails and leaves every local asset untouched.
    for (const asset of [...assets].sort((a, b) => a.packageSnapshotId.localeCompare(b.packageSnapshotId))) {
      const [row] = await tx.select().from(snapshots).where(and(eq(snapshots.companyId, input.companyId), eq(snapshots.id, asset.packageSnapshotId))).for("update");
      if (!row?.storage || row.storage.provider !== "s3" || row.contentHash !== asset.packageContentHash) throw new Error("runtime_skill_package_not_durable");
    }
    await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...current.runnerProfileJson,
      [RUNTIME_SKILL_PRESERVATION_KEY]: { schema: RUNTIME_SKILL_PRESERVATION_SCHEMA, inputDigest: admitted.inputDigest,
        bindingDigest: admitted.bindingDigest, assets } } }).where(where);
    await logActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "runtime-skill-preservation",
      action: "native_runtime_skill_assets_preserved", entityType: "heartbeat_run", entityId: input.runId,
      agentId: source.agentId, runId: input.runId, details: { inputDigest: admitted.inputDigest, assets: assets.length } }, publications);
  });
  for (const publication of publications) publishActivity(publication);
  return { preserved: assets.length };
}

export async function hasLocalRuntimeSkillObligations(db: Db): Promise<boolean> {
  let after: string | undefined;
  const checkedPackages = new Map<string, { hash: string; storage: typeof snapshots.$inferSelect.storage }>();
  for (;;) {
    const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      nativeIssueId: heartbeatRuns.nativeIssueId, runnerProfileJson: sql<Record<string, unknown>>`jsonb_build_object(
        'nativeExecutionInput', ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput',
        'nativeRuntimeSkillPreservation', ${heartbeatRuns.runnerProfileJson}->'nativeRuntimeSkillPreservation')` })
      .from(heartbeatRuns).where(and(retainedRuntimeSkillsSql(), after ? gt(heartbeatRuns.id, after) : undefined))
      .orderBy(asc(heartbeatRuns.id)).limit(100);
    for (const row of rows) {
      let receipt;
      try { receipt = readRuntimeSkillPreservation(row); } catch { return true; }
      if (!receipt) return true;
      for (const asset of receipt.assets) {
        try { manifestFiles(asset.bundle, asset.manifestText); } catch { return true; }
        const key = `${row.companyId}:${asset.packageSnapshotId}`;
        let snapshot = checkedPackages.get(key);
        if (!snapshot) {
          [snapshot] = await db.select({ hash: snapshots.contentHash, storage: snapshots.storage }).from(snapshots)
            .where(and(eq(snapshots.companyId, row.companyId), eq(snapshots.id, asset.packageSnapshotId)));
          if (snapshot) checkedPackages.set(key, snapshot);
        }
        if (snapshot?.storage?.provider !== "s3" || snapshot.hash !== asset.packageContentHash) return true;
      }
    }
    if (rows.length < 100) return false;
    after = rows.at(-1)!.id;
  }
}

/** Existing bounded skill maintenance owns this optional online conversion;
 * there is no scanner, new execution admission or controller takeover. */
export async function migrateRuntimeSkillAssets(db: Db, options: { companyId?: string; after?: string;
  limit?: number; apply?: boolean; signal?: AbortSignal } = {}, storage?: StorageService) {
  const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId }).from(heartbeatRuns)
    .where(and(retainedRuntimeSkillsSql(), options.companyId ? eq(heartbeatRuns.companyId, options.companyId) : undefined,
      options.after ? gt(heartbeatRuns.id, options.after) : undefined)).orderBy(asc(heartbeatRuns.id))
    .limit(Math.max(1, Math.min(50, options.limit ?? 10)));
  const results: Array<{ runId: string; status: "candidate" | "preserved"; preserved?: number }> = [];
  await withSkillPackageReadScope(db, async () => {
    for (const row of rows) {
      options.signal?.throwIfAborted();
      if (!options.apply) { results.push({ runId: row.id, status: "candidate" }); continue; }
      const result = await preserveRuntimeSkillAssets(db, { companyId: row.companyId, runId: row.id, signal: options.signal }, storage);
      results.push({ runId: row.id, status: "preserved", preserved: result.preserved });
    }
  });
  return { inspected: rows.length, after: rows.at(-1)?.id ?? null, results };
}

export async function rehydratePreservedRuntimeSkill(db: Db, row: Parameters<typeof admittedRuntimeSkills>[0],
  skill: NativeRuntimeContextSnapshot["skills"][number], materialize: (root: string) => Promise<NativeRuntimeAssetReference>) {
  const receipt = readRuntimeSkillPreservation(row);
  const asset = receipt?.assets.find(entry => sameRuntimeSkill(entry, skill));
  if (!asset) throw new Error("runtime_skill_preservation_required");
  const files = manifestFiles(asset.bundle, asset.manifestText);
  const store = skillPackageStore(db);
  const descriptor = await store.descriptor(row.companyId, asset.packageSnapshotId);
  if (descriptor.storage?.provider !== "s3" || descriptor.contentHash !== asset.packageContentHash) throw new Error("runtime_skill_package_not_durable");
  return store.withIsolatedPackage(row.companyId, asset.packageSnapshotId, async (root, manifest) => {
    if (manifest.files.length !== files.length || files.some(file => !manifest.files.some(entry => entry.path === file.path
      && entry.sha256 === file.sha256 && entry.size === file.size && entry.executable === Boolean(file.mode & 0o111)))) throw new Error("runtime_skill_package_mismatch");
    // Package storage preserves executable bits; the authenticated native
    // manifest additionally restores the exact original read/execute mode.
    for (const file of files) await fs.chmod(path.join(root, file.path), file.mode);
    const bundle = await materialize(root);
    if (!sameRuntimeSkill({ ...skill, bundle }, asset)) throw new Error("runtime_skill_projection_mismatch");
    return bundle;
  }, false);
}
