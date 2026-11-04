import { publishNativeHarnessBackup } from "./native-harness-backup-publication.js";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import type { StorageService } from "../../storage/types.js";
import { assertNativeRunnerCheckpointOwner, type NativeRunnerCheckpointOwner } from "./native-runner-checkpoint.js";
import { loadConfig } from "../../config.js";
import { getStorageService } from "../../storage/index.js";
import { readNativeHarnessBackupStamp, verifyNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { captureNativeHarnessArchive, restoreNativeHarnessArchive, MAX_NATIVE_HARNESS_OBJECT_BYTES } from "./native-harness-backup-archive.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { offlineMigrationExecutionWhere } from "../offline-migration-execution.js";

const SCHEMA = "paperclip.native-harness-object.v1";
type Binding = { companyId: string; scopeDigest: string; id: string };
type Reference = Binding & {
  schema: typeof SCHEMA; objectKey: string; sha256: string; byteSize: number;
  material: Record<string, unknown>; manifestSha256: string;
};
type Row = typeof nativeHarnessBackups.$inferSelect;
type OfflineOwner = { kind: "offline_migration"; companyId: string; issueId: string; runId: string;
  writersStopped: true; terminalFailureOnly?: true };
const fail = (reason: string): never => { throw new Error(`native_harness_storage_${reason}`); };
const aad = (binding: Binding) => Buffer.from(JSON.stringify([SCHEMA, binding.companyId, binding.scopeDigest, binding.id]));
const scope = (binding: Pick<Binding, "companyId" | "scopeDigest">) => and(
  eq(nativeHarnessBackups.companyId, binding.companyId), eq(nativeHarnessBackups.scopeDigest, binding.scopeDigest));

export function durableNativeHarnessStorage(): StorageService | null {
  if (loadConfig().storageProvider === "s3") return getStorageService();
  if (process.env.PAPERCLIP_EPHEMERAL_SERVER === "true") fail("durable_storage_required");
  return null;
}

export async function verifyRecoverableNativeHarnessBackup(input: {
  db: Db; companyId: string; stamp: unknown; providerLeaseId: string;
}): Promise<boolean> {
  const stamp = readNativeHarnessBackupStamp(input.stamp, input.providerLeaseId);
  if (!stamp) return false;
  const storage = durableNativeHarnessStorage();
  if (!storage) return verifyNativeHarnessBackupStamp(stamp, input.providerLeaseId);
  const durable = await verifyDurableNativeHarnessBackup({ db: input.db, storage, companyId: input.companyId,
    scopeDigest: stamp.sessionScopeSha256, manifestSha256: stamp.manifestSha256, signal: AbortSignal.timeout(300_000) });
  return durable || process.env.PAPERCLIP_EPHEMERAL_SERVER !== "true" && verifyNativeHarnessBackupStamp(stamp, input.providerLeaseId);
}
function reference(row: Row): Reference {
  const ref = row.reference as Reference;
  if (ref.schema !== SCHEMA || ref.id !== row.id || ref.companyId !== row.companyId || ref.scopeDigest !== row.scopeDigest
    || !/^[a-f0-9]{64}$/.test(ref.scopeDigest) || !/^[a-f0-9]{64}$/.test(ref.sha256)
    || ref.manifestSha256 !== row.manifestSha256 || !/^sha256:[a-f0-9]{64}$/.test(ref.manifestSha256)
    || ref.objectKey !== `${row.companyId}/native-harness-backups/${row.scopeDigest}/${row.id}.pchn`
    || !Number.isSafeInteger(ref.byteSize) || ref.byteSize <= 0 || ref.byteSize > MAX_NATIVE_HARNESS_OBJECT_BYTES
    || !ref.material || typeof ref.material !== "object") fail("reference_invalid");
  return ref;
}
async function digest(file: string, signal?: AbortSignal) {
  const hash = createHash("sha256"); let byteSize = 0;
  for await (const bytes of createReadStream(file, { signal })) { hash.update(bytes); byteSize += bytes.length; }
  return { sha256: hash.digest("hex"), byteSize };
}
async function receive(storage: StorageService, ref: Reference, target?: string, signal?: AbortSignal) {
  const object = await storage.getObject(ref.companyId, ref.objectKey, { signal });
  const hash = createHash("sha256"); let byteSize = 0;
  const observed = new Transform({ transform(bytes, _encoding, callback) {
    hash.update(bytes); byteSize += bytes.length;
    callback(byteSize > ref.byteSize ? new Error("native_harness_storage_size_mismatch") : null, bytes);
  } });
  try {
    if (target) await pipeline(object.stream, observed, createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
    else for await (const bytes of object.stream) {
      signal?.throwIfAborted(); hash.update(bytes); byteSize += bytes.length;
      if (byteSize > ref.byteSize) fail("size_mismatch");
    }
    if (byteSize !== ref.byteSize || hash.digest("hex") !== ref.sha256) fail("hash_mismatch");
  } finally { object.stream.destroy(); }
}

export async function nativeHarnessBackupOwner(db: Db, input: { companyId: string; issueId: string; runId: string; bootId: string }) {
  const [row] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
    eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.controllerBootId, input.bootId)));
  if (!row?.leaseOwner) fail("owner_missing");
  return { ...input, authorityRunId: input.runId, leaseOwner: row!.leaseOwner!, generation: row!.controllerGeneration } satisfies NativeRunnerCheckpointOwner;
}
async function fence(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], owner: NativeRunnerCheckpointOwner | OfflineOwner) {
  const [task] = await tx.select({ executionRunId: issues.executionRunId }).from(issues)
    .where(and(eq(issues.companyId, owner.companyId), eq(issues.id, owner.issueId))).for("share");
  const authorityRunId = "kind" in owner ? owner.runId : owner.authorityRunId;
  if (!task || !("kind" in owner) && task.executionRunId && task.executionRunId !== authorityRunId) fail("owner_superseded");
  if ("kind" in owner) {
    if (!owner.writersStopped) fail("offline_writers_required");
    const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(offlineMigrationExecutionWhere()).limit(1);
    if (active) fail("offline_writers_required");
    const [run] = await tx.select({ finishedAt: heartbeatRuns.finishedAt, status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, owner.runId), eq(heartbeatRuns.companyId, owner.companyId),
      eq(heartbeatRuns.nativeIssueId, owner.issueId), eq(heartbeatRuns.runtimeMode, "native"))).for("share");
    const [coordinator] = await tx.select({ leaseOwner: nativeRunFinalizations.leaseOwner,
      leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt, phase: nativeRunFinalizations.phase })
      .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, owner.runId)).for("share");
    const [clock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    if (!run?.finishedAt || !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status)
      || !coordinator || coordinator.leaseOwner && (!coordinator.leaseExpiresAt || coordinator.leaseExpiresAt > new Date(clock.now))
      || owner.terminalFailureOnly && (run.status !== "failed" || coordinator.phase !== "terminal_failure")) {
      fail("offline_owner_unsettled");
    }
    return;
  }
  await assertNativeRunnerCheckpointOwner(tx, owner, false);
}

export async function persistNativeHarnessBackup(input: {
  db: Db; storage: StorageService; owner: NativeRunnerCheckpointOwner | OfflineOwner;
  scopeDigest: string; root: string; signal?: AbortSignal;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.scopeDigest)) fail("scope_invalid");
  const manifestBytes = await readFile(join(input.root, "manifest.json"));
  const manifestSha256 = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  const binding = { companyId: input.owner.companyId, scopeDigest: input.scopeDigest, id: randomUUID() };
  const scratch = await mkdtemp(join(os.tmpdir(), "pc-harness-upload-"));
  const key = randomBytes(32);
  try {
    const archive = join(scratch, "archive"), encrypted = join(scratch, "encrypted");
    await captureNativeHarnessArchive(input.root, archive, input.signal);
    const plaintext = await digest(archive, input.signal), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad(binding));
    await pipeline(createReadStream(archive), cipher, createWriteStream(encrypted, { flags: "wx", mode: 0o600 }), { signal: input.signal });
    const ref: Reference = { schema: SCHEMA, ...binding, manifestSha256,
      objectKey: `${binding.companyId}/native-harness-backups/${binding.scopeDigest}/${binding.id}.pchn`,
      ...await digest(encrypted, input.signal),
      material: createLocalEncryptedCipher("write").encrypt(JSON.stringify({ schema: SCHEMA, ...binding,
        key: key.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), plaintext })) };
    if (ref.byteSize > MAX_NATIVE_HARNESS_OBJECT_BYTES) fail("size_limit_exceeded");
    await input.db.transaction(async tx => {
      await fence(tx, input.owner);
      await tx.insert(nativeHarnessBackups).values({ ...binding, issueId: input.owner.issueId, runId: input.owner.runId,
        manifestSha256, reference: ref });
    });
    await input.storage.putFile({ companyId: ref.companyId, namespace: "native-harness-backups", objectKey: ref.objectKey,
      originalFilename: null, contentType: "application/octet-stream", body: createReadStream(encrypted),
      byteSize: ref.byteSize, sha256: ref.sha256, signal: input.signal });
    await receive(input.storage, ref, undefined, input.signal);
    await input.db.transaction(async tx => {
      await fence(tx, input.owner);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${ref.companyId}:${ref.scopeDigest}`}, 0))`);
      const [pending] = await tx.select({ status: nativeHarnessBackups.status }).from(nativeHarnessBackups)
        .where(eq(nativeHarnessBackups.id, ref.id)).for("update");
      if (pending?.status !== "pending") fail("publication_retired");
      const [successor] = await tx.select({ id: nativeHarnessBackups.id }).from(nativeHarnessBackups)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, nativeHarnessBackups.runId)).where(and(scope(ref),
          eq(nativeHarnessBackups.status, "current"), sql`${nativeHarnessBackups.runId} <> ${input.owner.runId}::uuid`,
          sql`${heartbeatRuns.createdAt} >= (select created_at from heartbeat_runs where id = ${input.owner.runId}::uuid)`)).limit(1);
      if (successor) fail("owner_superseded");
      await fence(tx, input.owner);
      await tx.update(nativeHarnessBackups).set({ status: "superseded", updatedAt: new Date() })
        .where(and(scope(ref), eq(nativeHarnessBackups.status, "current")));
      await tx.update(nativeHarnessBackups).set({ status: "current", updatedAt: new Date() })
        .where(and(eq(nativeHarnessBackups.id, ref.id), eq(nativeHarnessBackups.status, "pending")));
    });
  } finally { key.fill(0); await removeNativeHarnessBackup(scratch); }
}

export async function restoreDurableNativeHarnessBackup(input: {
  db: Db; storage: StorageService; companyId: string; scopeDigest: string;
  backupRoot: string; signal?: AbortSignal;
}): Promise<boolean> {
  const [row] = await input.db.select().from(nativeHarnessBackups).where(and(scope(input), eq(nativeHarnessBackups.status, "current")));
  if (!row) return false;
  const ref = reference(row);
  const wrapped = JSON.parse(createLocalEncryptedCipher("read").decrypt(ref.material));
  if (wrapped.schema !== SCHEMA || wrapped.id !== ref.id || wrapped.companyId !== ref.companyId
    || wrapped.scopeDigest !== ref.scopeDigest) fail("binding_mismatch");
  const current = join(input.backupRoot, "current");
  const localManifest = await readFile(join(current, "manifest.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null; throw error;
  });
  if (localManifest && `sha256:${createHash("sha256").update(localManifest).digest("hex")}` === ref.manifestSha256) return true;
  const scratch = await mkdtemp(join(os.tmpdir(), "pc-harness-restore-"));
  const key = Buffer.from(wrapped.key, "base64");
  try {
    if (key.length !== 32) fail("key_invalid");
    const encrypted = join(scratch, "encrypted"), archive = join(scratch, "archive");
    await receive(input.storage, ref, encrypted, input.signal);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(wrapped.iv, "base64"));
    decipher.setAAD(aad(ref)); decipher.setAuthTag(Buffer.from(wrapped.tag, "base64"));
    await pipeline(createReadStream(encrypted), decipher, createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal: input.signal });
    const actual = await digest(archive, input.signal);
    if (actual.sha256 !== wrapped.plaintext?.sha256 || actual.byteSize !== wrapped.plaintext?.byteSize) fail("plaintext_mismatch");
    const restored = join(scratch, "restored");
    await restoreNativeHarnessArchive(archive, restored, input.signal);
    const manifest = await readFile(join(restored, "manifest.json"));
    if (`sha256:${createHash("sha256").update(manifest).digest("hex")}` !== ref.manifestSha256) fail("manifest_mismatch");
    const { mkdir, cp } = await import("node:fs/promises");
    await mkdir(input.backupRoot, { recursive: true, mode: 0o700 });
    const pending = join(input.backupRoot, `.durable-${randomUUID()}`);
    try {
      await cp(restored, pending, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      await publishNativeHarnessBackup({ db: input.db, companyId: input.companyId, scopeDigest: input.scopeDigest,
        backupRoot: input.backupRoot, pendingRoot: pending });
    } finally { await removeNativeHarnessBackup(pending); }
    return true;
  } finally { key.fill(0); await removeNativeHarnessBackup(scratch); }
}

export async function verifyDurableNativeHarnessBackup(input: {
  db: Db; storage: StorageService; companyId: string; scopeDigest: string; manifestSha256: string; signal?: AbortSignal;
}): Promise<boolean> {
  const [row] = await input.db.select().from(nativeHarnessBackups).where(and(scope(input),
    eq(nativeHarnessBackups.manifestSha256, input.manifestSha256), inArray(nativeHarnessBackups.status, ["current", "superseded"]))).limit(1);
  if (!row) return false;
  await receive(input.storage, reference(row), undefined, input.signal);
  return true;
}

export async function deleteRetiredNativeHarnessBackup(db: Db, storage: StorageService, id: string, signal?: AbortSignal) {
  const [row] = await db.select().from(nativeHarnessBackups).where(and(
    eq(nativeHarnessBackups.id, id), eq(nativeHarnessBackups.status, "retired")));
  if (!row) return false;
  const ref = reference(row);
  await storage.deleteObject(ref.companyId, ref.objectKey, { allVersions: true, signal });
  await db.delete(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.id, id), eq(nativeHarnessBackups.status, "retired")));
  return true;
}
