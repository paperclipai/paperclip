import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { heartbeatRuns, companySkillRepositorySnapshots as snapshots, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import type { StorageService } from "../../storage/types.js";
import { getStorageService } from "../../storage/index.js";
import { skillPackageStore, withSkillPackageReadScope } from "../skill-package-store.js";
import { assertSkillSnapshotPath, snapshotFile, skillSnapshotHash } from "../skill-snapshot.js";
import { ensureSkillCacheDirectory, skillRunNeedsFilesSql } from "../skill-version-cache.js";
import { inspectFileManifest, verifyFileManifest } from "../file-manifest-cache.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { withRuntimeAssetUse } from "./runtime-asset-retention.js";
import { admittedRuntimeSkills, hasUnversionedRuntimeSkillInputSql, readRuntimeSkillPreservation,
  RUNTIME_SKILL_PRESERVATION_KEY, RUNTIME_SKILL_PRESERVATION_SCHEMA, sameRuntimeSkill,
  type PreservedRuntimeSkill, type RuntimeSkillPreservation } from "./runtime-skill-preservation-reference.js";
import type { NativeExecutionInput, NativeRuntimeAssetReference, NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";

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
/** The admitted bundle's source is not on this filesystem: its directory,
 * manifest or a listed file is gone, or it was written under another instance
 * root. Only the source readers throw it; every other failure is real. */
export class RuntimeSkillSourceAbsent extends Error {
  constructor(readonly reason: "path_mismatch" | "missing") { super(`runtime_skill_source_absent:${reason}`); }
}
const missingPath = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
async function sourceRead<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) { throw missingPath(error) ? new RuntimeSkillSourceAbsent("missing") : error; }
}
type PackageRow = { contentHash: string; storage: typeof snapshots.$inferSelect.storage } | undefined;
/** The one durability test for a preserved asset. "metadata" trusts the
 * package row; "object" also reads the stored package back. A storage error
 * during the object read propagates: it is not evidence either way. */
function preservedAssetRowDurable(asset: PreservedRuntimeSkill, row: PackageRow) {
  try { manifestFiles(asset.bundle, asset.manifestText); } catch { return false; }
  return row?.storage?.provider === "s3" && row.storage.durable === true && row.contentHash === asset.packageContentHash;
}
async function preservedAssetDurable(store: ReturnType<typeof skillPackageStore>, companyId: string, asset: PreservedRuntimeSkill,
  verify: "metadata" | "object", signal?: AbortSignal) {
  const row = await store.descriptor(companyId, asset.packageSnapshotId).catch(() => undefined);
  if (!preservedAssetRowDurable(asset, row)) return false;
  return verify === "metadata" || await store.verifyDurable(companyId, asset.packageSnapshotId, signal);
}
async function readLocalManifest(asset: NativeRuntimeAssetReference) {
  const root = path.join(resolvePaperclipInstanceRoot(), "runtime-context-assets");
  const expected = path.join(root, "bundles", asset.digest);
  if (asset.rootPath !== expected) throw new RuntimeSkillSourceAbsent("path_mismatch");
  await sourceRead(() => ensureSkillCacheDirectory(expected));
  await sourceRead(() => ensureSkillCacheDirectory(path.join(root, "manifests")));
  const handle = await sourceRead(() => fs.open(path.join(root, "manifests", `${asset.digest}.json`), constants.O_RDONLY | constants.O_NOFOLLOW));
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error("runtime_skill_manifest_invalid");
    text = await handle.readFile("utf8");
  } finally { await handle.close(); }
  const entries = manifestFiles(asset, text);
  return { expected, manifestText: text, entries };
}
async function readSource(asset: NativeRuntimeAssetReference) {
  const { expected, manifestText, entries } = await readLocalManifest(asset);
  const inspected = await inspectFileManifest(expected, entries.map(f => ({ ...f, executable: Boolean(f.mode & 0o111) })));
  if (inspected === "missing") throw new RuntimeSkillSourceAbsent("missing");
  if (inspected === "changed") throw new Error("runtime_skill_source_changed");
  const files = [];
  for (const entry of entries) {
    const handle = await sourceRead(() => fs.open(path.join(expected, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size || (stat.mode & 0o777) !== entry.mode) throw new Error("runtime_skill_source_changed");
      const bytes = await handle.readFile();
      if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error("runtime_skill_source_changed");
      files.push(snapshotFile(entry.path, entry.path === "SKILL.md" ? "skill" : "other", bytes, Boolean(entry.mode & 0o111)));
    } finally { await handle.close(); }
  }
  return { manifestText, files };
}

async function captureSkills(db: Db, companyId: string, admitted: ReturnType<typeof admittedRuntimeSkills>, storage?: StorageService, signal?: AbortSignal) {
  const store = skillPackageStore(db, storage), assets: PreservedRuntimeSkill[] = [];
  for (const skill of admitted.skills) {
    signal?.throwIfAborted();
    const captured = await withRuntimeAssetUse(skill.bundle.digest, () => readSource(skill.bundle), true);
    const packageSnapshotId = await store.prepare(companyId, captured.files, true, signal);
    if (!await store.verifyDurable(companyId, packageSnapshotId, signal)) throw new Error("runtime_skill_package_not_durable");
    assets.push({ key: skill.key, runtimeName: skill.runtimeName, bundle: skill.bundle, manifestText: captured.manifestText,
      packageSnapshotId, packageContentHash: skillSnapshotHash(captured.files) });
  }
  return assets;
}

async function lockPackages(db: Db, companyId: string, assets: PreservedRuntimeSkill[]) {
  for (const asset of [...assets].sort((a, b) => a.packageSnapshotId.localeCompare(b.packageSnapshotId))) {
    const [row] = await db.select().from(snapshots).where(and(eq(snapshots.companyId, companyId), eq(snapshots.id, asset.packageSnapshotId))).for("update");
    if (!preservedAssetRowDurable(asset, row)) throw new Error("runtime_skill_package_not_durable");
  }
}

type Admission = { companyId: string; runId: string; agentId: string; issueId: string; execution: NativeExecutionInput };
export type StagedRuntimeSkillAssets = { inputDigest: string; receipt: RuntimeSkillPreservation };
const admissionSource = (input: Admission) => ({ id: input.runId, companyId: input.companyId, agentId: input.agentId,
  nativeIssueId: input.issueId, runnerProfileJson: { nativeExecutionInput: input.execution } });

export async function stageNativeRuntimeSkillAssets(db: Db, input: Admission & { signal?: AbortSignal }, storage?: StorageService): Promise<StagedRuntimeSkillAssets | null> {
  if (!("runtimeContext" in input.execution)) return null;
  const source = admissionSource(input), admitted = admittedRuntimeSkills(source);
  if (!admitted.skills.length) return null;
  const shared = storage ?? getStorageService();
  if (shared.provider !== "s3") return null;
  const [current] = await db.select({ receipt: sql<unknown>`${heartbeatRuns.runnerProfileJson}->${RUNTIME_SKILL_PRESERVATION_KEY}` }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.id, input.runId)));
  if (!current) throw new Error("runtime_skill_source_unavailable");
  const previous = current.receipt;
  let receipt = previous == null ? null : readRuntimeSkillPreservation({ ...source,
    runnerProfileJson: { ...source.runnerProfileJson, [RUNTIME_SKILL_PRESERVATION_KEY]: previous } });
  if (previous != null && !receipt) throw new Error("runtime_skill_preservation_receipt_invalid");
  if (receipt) {
    const store = skillPackageStore(db, shared);
    for (const asset of receipt.assets) {
      if (!await preservedAssetDurable(store, input.companyId, asset, "metadata")) throw new Error("runtime_skill_package_not_durable");
    }
  } else receipt = { schema: RUNTIME_SKILL_PRESERVATION_SCHEMA, inputDigest: admitted.inputDigest,
    bindingDigest: admitted.bindingDigest, assets: await captureSkills(db, input.companyId, admitted, shared, input.signal) };
  return { inputDigest: admitted.inputDigest, receipt };
}

export async function bindStagedNativeRuntimeSkillAssets(db: Db, input: Admission & { staged: StagedRuntimeSkillAssets | null }) {
  if (!input.staged) return null;
  const source = admissionSource(input), admitted = admittedRuntimeSkills(source);
  const receipt = readRuntimeSkillPreservation({ ...source, runnerProfileJson: {
    ...source.runnerProfileJson, [RUNTIME_SKILL_PRESERVATION_KEY]: input.staged.receipt } });
  if (!receipt || input.staged.inputDigest !== admitted.inputDigest) throw new Error("runtime_skill_preservation_binding_changed");
  await lockPackages(db, input.companyId, receipt.assets);
  return receipt;
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
  if (existing) {
    let durable = true;
    for (const asset of existing.assets) if (durable) durable = await preservedAssetDurable(store, input.companyId, asset, "object", input.signal);
    if (durable) return { preserved: existing.assets.length };
  }
  // No receipt, an invalid one, or one whose package is not durable: copy the
  // admitted bytes again and replace it. A missing source throws RuntimeSkillSourceAbsent.
  const previousReceipt = JSON.stringify(source.runnerProfileJson?.[RUNTIME_SKILL_PRESERVATION_KEY] ?? null);
  const assets = await captureSkills(db, input.companyId, admitted, storage, input.signal);
  if (!assets.length) return { preserved: 0 };
  const publications: ActivityPublication[] = [];
  await db.transaction(async tx => {
    const [current] = await tx.select().from(heartbeatRuns).where(where).for("update");
    if (!current || admittedRuntimeSkills(current).inputDigest !== admitted.inputDigest || current.status !== source.status
      || current.finishedAt?.getTime() !== source.finishedAt?.getTime()
      || JSON.stringify(current.runnerProfileJson?.[RUNTIME_SKILL_PRESERVATION_KEY] ?? null) !== previousReceipt) {
      throw new Error("runtime_skill_preservation_binding_changed");
    }
    await lockPackages(tx as unknown as Db, input.companyId, assets);
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

/** Retained runs whose admitted local skill bundles have no durable receipt. */
async function* localRuntimeSkillObligations(db: Db): AsyncGenerator<{ id: string; companyId: string }> {
  let after: string | undefined;
  const checkedPackages = new Map<string, NonNullable<PackageRow>>();
  // Metadata only: this scan runs before every volume-free start.
  const durable = async (companyId: string, asset: PreservedRuntimeSkill) => {
    const key = `${companyId}:${asset.packageSnapshotId}`;
    let snapshot = checkedPackages.get(key);
    if (!snapshot) {
      [snapshot] = await db.select({ contentHash: snapshots.contentHash, storage: snapshots.storage }).from(snapshots)
        .where(and(eq(snapshots.companyId, companyId), eq(snapshots.id, asset.packageSnapshotId)));
      if (snapshot) checkedPackages.set(key, snapshot);
    }
    return preservedAssetRowDurable(asset, snapshot);
  };
  for (;;) {
    const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      nativeIssueId: heartbeatRuns.nativeIssueId, runnerProfileJson: sql<Record<string, unknown>>`jsonb_build_object(
        'nativeExecutionInput', ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput',
        'nativeRuntimeSkillPreservation', ${heartbeatRuns.runnerProfileJson}->'nativeRuntimeSkillPreservation')` })
      .from(heartbeatRuns).where(and(retainedRuntimeSkillsSql(), after ? gt(heartbeatRuns.id, after) : undefined))
      .orderBy(asc(heartbeatRuns.id)).limit(100);
    for (const row of rows) {
      let receipt: RuntimeSkillPreservation | null;
      try { receipt = readRuntimeSkillPreservation(row); } catch { receipt = null; }
      let settled = receipt !== null;
      for (const asset of receipt?.assets ?? []) if (settled) settled = await durable(row.companyId, asset);
      if (!settled) yield { id: row.id, companyId: row.companyId };
    }
    if (rows.length < 100) return;
    after = rows.at(-1)!.id;
  }
}

export async function hasLocalRuntimeSkillObligations(db: Db): Promise<boolean> {
  for await (const _ of localRuntimeSkillObligations(db)) return true;
  return false;
}

/** Copies every retained bundle this filesystem still holds into durable
 * storage: the same copy the skill package maintenance command makes. A run
 * whose bundle source is not here is reported as unsaved, never guessed at.
 * Any other failure (a changed source, storage) propagates to the caller. */
export async function preserveLocalRuntimeSkillObligations(db: Db, options: { signal?: AbortSignal } = {}, storage?: StorageService) {
  let bundles = 0;
  const unsaved: string[] = [];
  await withSkillPackageReadScope(db, async () => {
    for await (const run of localRuntimeSkillObligations(db)) {
      options.signal?.throwIfAborted();
      try {
        const { preserved } = await preserveRuntimeSkillAssets(db, { companyId: run.companyId, runId: run.id, signal: options.signal }, storage);
        if (preserved) bundles += preserved;
        else unsaved.push(run.id);
      } catch (error) {
        if (!(error instanceof RuntimeSkillSourceAbsent)) throw error;
        unsaved.push(run.id);
      }
    }
  });
  return { bundles, unsaved };
}

/** Existing bounded skill maintenance owns this optional online conversion;
 * there is no scanner, new execution admission or controller takeover. */
export async function migrateRuntimeSkillAssets(db: Db, options: { companyId?: string; after?: string;
  limit?: number; apply?: boolean; signal?: AbortSignal } = {}, storage?: StorageService) {
  const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId }).from(heartbeatRuns)
    .where(and(retainedRuntimeSkillsSql(), options.companyId ? eq(heartbeatRuns.companyId, options.companyId) : undefined,
      options.after ? gt(heartbeatRuns.id, options.after) : undefined)).orderBy(asc(heartbeatRuns.id))
    .limit(Math.max(1, Math.min(50, options.limit ?? 10)));
  const results: Array<{ runId: string; status: "candidate" } | { runId: string; status: "preserved"; preserved: number }
    | { runId: string; status: "unsaved"; code: `runtime_skill_source_absent:${RuntimeSkillSourceAbsent["reason"]}` }> = [];
  await withSkillPackageReadScope(db, async () => {
    for (const row of rows) {
      options.signal?.throwIfAborted();
      if (!options.apply) { results.push({ runId: row.id, status: "candidate" }); continue; }
      try {
        const result = await preserveRuntimeSkillAssets(db, { companyId: row.companyId, runId: row.id, signal: options.signal }, storage);
        results.push({ runId: row.id, status: "preserved", preserved: result.preserved });
      } catch (error) {
        if (!(error instanceof RuntimeSkillSourceAbsent)) throw error;
        results.push({ runId: row.id, status: "unsaved", code: `runtime_skill_source_absent:${error.reason}` });
      }
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
  if (!await preservedAssetDurable(store, row.companyId, asset, "metadata")) throw new Error("runtime_skill_package_not_durable");
  // An intact disposable cache remains useful during a storage outage. Only
  // use the current host's canonical cache, never the old host's recorded path.
  const local = { ...skill.bundle, rootPath: path.join(resolvePaperclipInstanceRoot(), "runtime-context-assets", "bundles", skill.bundle.digest) };
  const healthy = await withRuntimeAssetUse(local.digest, async () => {
    try {
      const { expected, entries } = await readLocalManifest(local);
      return await verifyFileManifest(expected, entries.map(file => ({ ...file, executable: Boolean(file.mode & 0o111) })));
    } catch (error) {
      if (error instanceof RuntimeSkillSourceAbsent || missingPath(error)
        || error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("runtime_skill_manifest_"))) return false;
      throw error;
    }
  });
  if (healthy) return local;
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
