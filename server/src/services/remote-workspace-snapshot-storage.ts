import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { executionWorkspaceSnapshots, type Db } from "@paperclipai/db";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import type { StorageService } from "../storage/types.js";
import { notifyRemoteWorkspaceSnapshots, REMOTE_WORKSPACE_SNAPSHOT_GRACE_MS } from "./remote-workspace-snapshot-retention.js";
import { WORKSPACE_ARCHIVE_IO_BUFFER_BYTES } from "./remote-workspace-archive-io.js";

const SCHEMA = "paperclip.workspace-snapshot.v1";
const KEY_SCHEMA = "paperclip.workspace-snapshot-key.v1";
const MAGIC = Buffer.from("PCWSE1\n");
const FORMAT = "paperclip.remote-workspace-archive.v1";
const DOWNLOAD_IDLE_TIMEOUT_MS = 5 * 60_000;
type SnapshotRow = typeof executionWorkspaceSnapshots.$inferSelect;
export interface WorkspaceSnapshotRef {
  schema: typeof SCHEMA;
  id: string;
  companyId: string;
  workspaceId: string;
  generation: number;
  objectKey: string;
  sha256: string;
  byteSize: number;
  key: StoredSecretVersionMaterial;
  manifestDigest: string;
}
type UploadAttempt = Omit<WorkspaceSnapshotRef, "schema" | "companyId" | "workspaceId" | "generation" | "id">;
function failure(reason: string): never { throw new Error(`remote_workspace_snapshot_${reason}`); }
const aad = (ref: Pick<WorkspaceSnapshotRef, "companyId" | "workspaceId" | "id" | "generation">) =>
  Buffer.from(JSON.stringify([SCHEMA, ref.companyId, ref.workspaceId, ref.id, ref.generation]));
const scope = (input: { companyId: string; workspaceId: string; snapshotId: string }) => and(
  eq(executionWorkspaceSnapshots.id, input.snapshotId), eq(executionWorkspaceSnapshots.companyId, input.companyId),
  eq(executionWorkspaceSnapshots.executionWorkspaceId, input.workspaceId),
);
function reference(row: SnapshotRow): WorkspaceSnapshotRef {
  if (!row.objectKey || !row.sha256 || !row.byteSize || !row.key || !row.manifestDigest) failure("not_uploaded");
  const value = { schema: SCHEMA, id: row.id, companyId: row.companyId, workspaceId: row.executionWorkspaceId,
    generation: row.generation, objectKey: row.objectKey!, sha256: row.sha256!, byteSize: row.byteSize!, key: row.key!, manifestDigest: row.manifestDigest! } as WorkspaceSnapshotRef;
  validateReference(value);
  return value;
}
function validateReference(ref: WorkspaceSnapshotRef) {
  if (ref.schema !== SCHEMA || !Number.isSafeInteger(ref.generation) || ref.generation < 1
    || !ref.objectKey.startsWith(`${ref.companyId}/workspace-snapshots/${ref.workspaceId}/${ref.id}/`)
    || !/^[a-f0-9]{64}$/.test(ref.sha256) || !/^[a-f0-9]{64}$/.test(ref.manifestDigest)
    || !Number.isSafeInteger(ref.byteSize) || ref.byteSize < MAGIC.length + 12 + 16
    || !ref.key || typeof ref.key !== "object") failure("reference_invalid");
}
async function digestFile(file: string, signal?: AbortSignal) {
  const digest = createHash("sha256"); let byteSize = 0;
  for await (const part of createReadStream(file, { signal, highWaterMark: WORKSPACE_ARCHIVE_IO_BUFFER_BYTES })) { digest.update(part); byteSize += part.length; }
  return { sha256: digest.digest("hex"), byteSize };
}
async function verifyStoredSize(storage: StorageService, ref: WorkspaceSnapshotRef, signal?: AbortSignal) {
  const head = await storage.headObject(ref.companyId, ref.objectKey, { signal });
  if (!head.exists || head.contentLength !== ref.byteSize) failure("object_size_mismatch");
}
async function verifyObject(storage: StorageService, ref: WorkspaceSnapshotRef, signal?: AbortSignal) {
  const object = await storage.getObject(ref.companyId, ref.objectKey, { signal });
  const digest = createHash("sha256"); let size = 0;
  try {
    for await (const chunk of object.stream) {
      signal?.throwIfAborted(); size += chunk.length;
      if (size > ref.byteSize) failure("object_size_mismatch");
      digest.update(chunk);
    }
    if (size !== ref.byteSize || digest.digest("hex") !== ref.sha256) failure("object_hash_mismatch");
  } finally { object.stream.destroy(); }
}

export async function beginWorkspaceSnapshot(db: Db, input: {
  companyId: string; workspaceId: string; operationId: string; runId?: string | null;
  parentSnapshotId?: string | null; generation: number; epoch: number;
}) {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isSafeInteger(input.epoch) || input.epoch < 0) failure("generation_invalid");
  await db.transaction(async tx => {
    await notifyRemoteWorkspaceSnapshots(tx, `workspace:${input.workspaceId}`);
    await tx.insert(executionWorkspaceSnapshots).values({ companyId: input.companyId, executionWorkspaceId: input.workspaceId,
      sourceOperationId: input.operationId, sourceRunId: input.runId ?? null, parentSnapshotId: input.parentSnapshotId ?? null,
      generation: input.generation, epoch: input.epoch, format: FORMAT,
      deleteAfter: new Date(Date.now() + REMOTE_WORKSPACE_SNAPSHOT_GRACE_MS) }).onConflictDoNothing();
  });
  const [row] = await db.select().from(executionWorkspaceSnapshots).where(and(
    eq(executionWorkspaceSnapshots.companyId, input.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, input.workspaceId),
    eq(executionWorkspaceSnapshots.sourceOperationId, input.operationId),
  ));
  if (!row || row.generation !== input.generation || row.epoch !== input.epoch || row.parentSnapshotId !== (input.parentSnapshotId ?? null)
    || row.sourceRunId !== (input.runId ?? null)) failure("operation_binding_changed");
  return row!;
}

export async function getWorkspaceSnapshot(db: Db, input: { companyId: string; workspaceId: string; snapshotId: string }) {
  const [row] = await db.select().from(executionWorkspaceSnapshots).where(scope(input));
  return row && ["uploaded", "committed", "superseded"].includes(row.status) ? reference(row) : null;
}

export async function recoverWorkspaceSnapshotArchive(input: {
  db: Db; storage: StorageService; snapshotId: string; companyId: string; workspaceId: string;
  targetPath: string; signal?: AbortSignal;
}): Promise<WorkspaceSnapshotRef | null> {
  const [row] = await input.db.select().from(executionWorkspaceSnapshots).where(scope(input));
  if (!row) failure("missing");
  if (["uploaded", "committed", "superseded"].includes(row!.status)) {
    const ref = reference(row!);
    await loadWorkspaceSnapshotArchive({ ...input, reference: ref });
    return ref;
  }
  if (row!.status !== "pending") failure("not_writable");
  const attempts = Array.isArray(row!.metadata?.uploads) ? row!.metadata!.uploads as UploadAttempt[] : [];
  for (const attempt of attempts) {
    input.signal?.throwIfAborted();
    const ref: WorkspaceSnapshotRef = { schema: SCHEMA, ...attempt, id: row!.id, companyId: row!.companyId,
      workspaceId: row!.executionWorkspaceId, generation: row!.generation };
    validateReference(ref);
    if (!(await input.storage.headObject(ref.companyId, ref.objectKey, { signal: input.signal })).exists) continue;
    await loadWorkspaceSnapshotArchive({ ...input, reference: ref });
    return ref;
  }
  return null;
}

type WorkspaceSnapshotUpload = {
  db: Db; storage: StorageService; snapshotId: string; companyId: string; workspaceId: string;
  archivePath: string; manifestDigest: string; signal?: AbortSignal; verifiedArchivePath?: string;
  // Only an owner with an immutable logical source may replace an unavailable,
  // unpublished capture. A recoverable or concurrently published attempt wins,
  // and its returned manifest may differ from the new physical capture.
  unpublishedRecapture?: { sourceOperationId: string };
};

/** Upload attempts are journaled before remote I/O. The caller owns publication. */
export async function uploadWorkspaceSnapshot(input: WorkspaceSnapshotUpload): Promise<WorkspaceSnapshotRef> {
  if (input.verifiedArchivePath === undefined)
    return uploadVerifiedWorkspaceSnapshot(input, ref => verifyObject(input.storage, ref, input.signal), { acceptServerVerifiedUpload: true });
  input.signal?.throwIfAborted();
  const target = input.verifiedArchivePath, parent = path.dirname(target);
  if (!path.isAbsolute(target) || path.normalize(target) !== target) failure("readback_parent_invalid");
  const owner = await lstat(parent);
  const assertParent = async () => {
    const current = await lstat(parent);
    if (!current.isDirectory() || current.isSymbolicLink() || (current.mode & 0o777) !== 0o700
      || typeof process.getuid === "function" && current.uid !== process.getuid()
      || current.dev !== owner.dev || current.ino !== owner.ino || await realpath(parent) !== parent) failure("readback_parent_invalid");
  };
  await assertParent();
  await lstat(target).then(() => failure("readback_target_exists"), (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const scratch = await mkdtemp(path.join(parent, ".workspace-upload-readback-"));
  const verified: Array<{ ref: WorkspaceSnapshotRef; file: string }> = [];
  const verify = async (ref: WorkspaceSnapshotRef) => {
    if (verified.some(saved => isDeepStrictEqual(saved.ref, ref))) return;
    const file = path.join(scratch, `${randomUUID()}.pcws`);
    await loadWorkspaceSnapshotArchive({ storage: input.storage, reference: ref, targetPath: file,
      signal: input.signal, temporaryParent: scratch });
    verified.push({ ref: structuredClone(ref), file });
  };
  try {
    // This caller keeps the read-back file, so every upload is read back.
    const ref = await uploadVerifiedWorkspaceSnapshot(input, verify, { acceptServerVerifiedUpload: false });
    await verify(ref);
    const file = verified.find(saved => isDeepStrictEqual(saved.ref, ref))!.file;
    const wrapped = await snapshotKey(ref), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat(), digest = createHash("sha256"); let bytes = 0;
      if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1
        || typeof process.getuid === "function" && before.uid !== process.getuid()) failure("readback_file_changed");
      for await (const chunk of createReadStream(file, { fd: handle.fd, autoClose: false, signal: input.signal, highWaterMark: WORKSPACE_ARCHIVE_IO_BUFFER_BYTES })) {
        digest.update(chunk); bytes += chunk.length;
      }
      const after = await handle.stat(), named = await lstat(file);
      if (!named.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino
        || named.nlink !== 1 || named.mode !== before.mode || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || bytes !== wrapped.plaintextBytes || digest.digest("hex") !== wrapped.plaintextSha256) failure("readback_file_changed");
      await assertParent(); input.signal?.throwIfAborted();
      await link(file, target);
    } finally { await handle.close(); }
    return ref;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function uploadVerifiedWorkspaceSnapshot(input: WorkspaceSnapshotUpload, verify: (ref: WorkspaceSnapshotRef) => Promise<void>,
  options: { acceptServerVerifiedUpload: boolean }): Promise<WorkspaceSnapshotRef> {
  const [row] = await input.db.select().from(executionWorkspaceSnapshots).where(scope(input));
  if (!row) failure("missing");
  if (input.unpublishedRecapture && row!.sourceOperationId !== input.unpublishedRecapture.sourceOperationId) failure("operation_binding_changed");
  if (["uploaded", "committed", "superseded"].includes(row!.status)) {
    const saved = reference(row!);
    if (saved.manifestDigest !== input.manifestDigest) failure("operation_content_changed");
    await verify(saved); return saved;
  }
  if (row!.status !== "pending" || !/^[a-f0-9]{64}$/.test(input.manifestDigest)) failure("not_writable");
  const recapture = Boolean(input.unpublishedRecapture);
  const requireUnpublished = (current: SnapshotRow) => {
    if (current.sourceOperationId !== input.unpublishedRecapture!.sourceOperationId
      || current.objectKey !== null || current.sha256 !== null || current.byteSize !== null
      || current.key !== null || current.manifestDigest !== null) failure("not_unpublished");
  };
  if (recapture) requireUnpublished(row!);
  const identity = { id: row!.id, companyId: row!.companyId, workspaceId: row!.executionWorkspaceId, generation: row!.generation };
  const publish = async (attempt: UploadAttempt) => {
    const updated = await input.db.transaction(async tx => {
      await notifyRemoteWorkspaceSnapshots(tx, `workspace:${input.workspaceId}`);
      return (await tx.update(executionWorkspaceSnapshots).set({ ...attempt, status: "uploaded", updatedAt: new Date() })
        .where(and(scope(input), eq(executionWorkspaceSnapshots.status, "pending"))).returning())[0];
    });
    const winning = updated ?? (await input.db.select().from(executionWorkspaceSnapshots).where(scope(input)))[0];
    if (!winning || !["uploaded", "committed", "superseded"].includes(winning.status)) failure("publication_changed");
    const saved = reference(winning!);
    if (!recapture && saved.manifestDigest !== input.manifestDigest) failure("operation_content_changed");
    if (saved.objectKey !== attempt.objectKey) await verify(saved);
    return saved;
  };
  // Recover a completed upload even when the previous process lost its reply
  // and its scratch directory. Failed attempts remain referenced for cleanup.
  const availableAttempt = async (attempts: UploadAttempt[]) => {
    for (const attempt of attempts) {
      input.signal?.throwIfAborted();
      if (!recapture && attempt.manifestDigest !== input.manifestDigest) failure("operation_content_changed");
      const ref = { schema: SCHEMA, ...identity, ...attempt } as WorkspaceSnapshotRef;
      validateReference(ref);
      if ((await input.storage.headObject(ref.companyId, ref.objectKey, { signal: input.signal })).exists) {
        await verify(ref); return attempt;
      }
    }
    return null;
  };
  const attempts = Array.isArray(row!.metadata?.uploads) ? row!.metadata!.uploads as UploadAttempt[] : [];
  const available = await availableAttempt(attempts);
  if (available) return publish(available);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "pc-workspace-encrypt-"));
  try {
    const encrypted = path.join(scratch, "archive.encrypted"), dataKey = randomBytes(32), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv); cipher.setAAD(aad(identity));
    const header = await open(encrypted, "wx", 0o600);
    try { await header.writeFile(Buffer.concat([MAGIC, iv])); } finally { await header.close(); }
    // One read of the archive both digests and encrypts it. An unchanged file
    // identity across that read replaces the separate digest pass.
    const before = await lstat(input.archivePath);
    const incomingDigest = createHash("sha256"); let incomingBytes = 0;
    const observed = new Transform({ transform(bytes, _encoding, callback) { incomingDigest.update(bytes); incomingBytes += bytes.length; callback(null, bytes); } });
    await pipeline(createReadStream(input.archivePath, { signal: input.signal, highWaterMark: WORKSPACE_ARCHIVE_IO_BUFFER_BYTES }), observed, cipher, createWriteStream(encrypted, { flags: "a", mode: 0o600, highWaterMark: WORKSPACE_ARCHIVE_IO_BUFFER_BYTES }), { signal: input.signal });
    const after = await lstat(input.archivePath);
    if (!before.isFile() || before.isSymbolicLink() || incomingBytes !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) failure("archive_changed");
    const plaintext = { sha256: incomingDigest.digest("hex"), byteSize: incomingBytes };
    const footer = await open(encrypted, "a"); try { await footer.writeFile(cipher.getAuthTag()); } finally { await footer.close(); }
    const { material } = await localEncryptedProvider.createVersion({ value: JSON.stringify({ schema: KEY_SCHEMA,
      ...identity, dataKey: dataKey.toString("base64"), plaintextSha256: plaintext.sha256, plaintextBytes: plaintext.byteSize }) });
    dataKey.fill(0);
    // Digest the encrypted file as stored: upload parts are read from these bytes.
    const content = await digestFile(encrypted, input.signal);
    const attempt: UploadAttempt = { objectKey: `${identity.companyId}/workspace-snapshots/${identity.workspaceId}/${identity.id}/${randomUUID()}.pcws`,
      ...content, key: material, manifestDigest: input.manifestDigest };
    // Recheck after encryption, then bind admission to the unchanged ledger.
    // Remote I/O stays outside the row lock. An older upload completing after
    // this check can still win the pending-to-uploaded publication below.
    if (recapture) {
      const recovered = await availableAttempt(attempts);
      if (recovered) return publish(recovered);
    }
    const recorded = await input.db.transaction(async tx => {
      const [current] = await tx.select().from(executionWorkspaceSnapshots).where(scope(input)).for("update");
      if (!current || current.status !== "pending") return null;
      const previous = Array.isArray(current.metadata?.uploads) ? current.metadata.uploads as UploadAttempt[] : [];
      if (recapture) {
        requireUnpublished(current);
        if (!isDeepStrictEqual(previous, attempts)) failure("upload_attempts_changed");
      } else if (previous.some(saved => saved.manifestDigest !== input.manifestDigest)) failure("operation_content_changed");
      await notifyRemoteWorkspaceSnapshots(tx, `workspace:${input.workspaceId}`);
      await tx.update(executionWorkspaceSnapshots).set({ metadata: { ...current.metadata, uploads: [...previous, attempt] }, updatedAt: new Date() }).where(scope(input));
      return true;
    });
    if (!recorded) {
      const saved = await getWorkspaceSnapshot(input.db, input);
      if (!saved || (!recapture && saved.manifestDigest !== input.manifestDigest)) failure("publication_changed");
      await verify(saved); return saved;
    }
    // The object key is unique per attempt, so a late losing uploader cannot
    // overwrite an object already used by a committed generation.
    const stored = await input.storage.putFile({ companyId: identity.companyId, namespace: "workspace-snapshots", objectKey: attempt.objectKey,
      originalFilename: null, contentType: "application/octet-stream", body: createReadStream(encrypted, { highWaterMark: WORKSPACE_ARCHIVE_IO_BUFFER_BYTES }),
      byteSize: attempt.byteSize, sha256: attempt.sha256, sourceFile: encrypted, signal: input.signal });
    const uploaded = { schema: SCHEMA, ...identity, ...attempt } as WorkspaceSnapshotRef;
    // The backend checked every part of this upload against digests of these
    // exact bytes, so only its size needs confirming. Any other provider, and
    // a caller that needs the bytes back, still reads the object back.
    if (options.acceptServerVerifiedUpload && stored.integrity === "server_verified_md5") await verifyStoredSize(input.storage, uploaded, input.signal);
    else await verify(uploaded);
    if (recapture) {
      const recovered = await availableAttempt(attempts);
      if (recovered) return publish(recovered);
    }
    return await publish(attempt);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function snapshotKey(ref: WorkspaceSnapshotRef) {
  validateReference(ref);
  const wrapped = JSON.parse(await localEncryptedProvider.resolveVersion({ material: ref.key, externalRef: null }));
  if (wrapped.schema !== KEY_SCHEMA || wrapped.companyId !== ref.companyId || wrapped.workspaceId !== ref.workspaceId
    || wrapped.id !== ref.id || wrapped.generation !== ref.generation || !/^[a-f0-9]{64}$/.test(wrapped.plaintextSha256 ?? "")
    || !Number.isSafeInteger(wrapped.plaintextBytes) || wrapped.plaintextBytes < 0) failure("key_binding_invalid");
  return wrapped;
}

/** Authentication finishes in private scratch before any plaintext is published. */
export async function loadWorkspaceSnapshotArchive(input: {
  storage: StorageService; reference: WorkspaceSnapshotRef; targetPath: string; signal?: AbortSignal; temporaryParent?: string;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const ref = input.reference, wrapped = await snapshotKey(ref);
  const scratch = await mkdtemp(path.join(input.temporaryParent ?? os.tmpdir(), "pc-workspace-decrypt-"));
  try {
    input.signal?.throwIfAborted();
    const ciphertext = path.join(scratch, "ciphertext"), plaintext = path.join(scratch, "plaintext");
    let received = 0; const digest = createHash("sha256");
    const stalled = new DOMException("remote_workspace_snapshot_download_stalled", "TimeoutError");
    const idle = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, idle.signal]) : idle.signal;
    const timer = setTimeout(() => idle.abort(stalled), DOWNLOAD_IDLE_TIMEOUT_MS);
    timer.unref();
    try {
      const object = await input.storage.getObject(ref.companyId, ref.objectKey, { signal });
      const bounded = new Transform({ transform(bytes, _encoding, callback) {
        if (bytes.length > 0) timer.refresh();
        received += bytes.length; digest.update(bytes);
        callback(received > ref.byteSize ? new Error("remote_workspace_snapshot_object_size_mismatch") : null, bytes);
      } });
      try { await pipeline(object.stream, bounded, createWriteStream(ciphertext, { flags: "wx", mode: 0o600, highWaterMark: WORKSPACE_ARCHIVE_IO_BUFFER_BYTES }), { signal }); }
      finally { object.stream.destroy(); }
    } catch (error) {
      if (signal.aborted && signal.reason === stalled) throw stalled;
      throw error;
    } finally { clearTimeout(timer); }
    if (received !== ref.byteSize || digest.digest("hex") !== ref.sha256) failure("object_hash_mismatch");
    const file = await open(ciphertext, "r"), header = Buffer.alloc(MAGIC.length + 12), tag = Buffer.alloc(16);
    try { await file.read(header, 0, header.length, 0); await file.read(tag, 0, tag.length, ref.byteSize - tag.length); } finally { await file.close(); }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) failure("ciphertext_header_invalid");
    const key = Buffer.from(wrapped.dataKey, "base64"); if (key.length !== 32) failure("key_invalid");
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
    decipher.setAAD(aad(ref)); decipher.setAuthTag(tag);
    try {
      await pipeline(createReadStream(ciphertext, { start: header.length, end: ref.byteSize - tag.length - 1, signal: input.signal, highWaterMark: WORKSPACE_ARCHIVE_IO_BUFFER_BYTES }),
        decipher, createWriteStream(plaintext, { flags: "wx", mode: 0o600, highWaterMark: WORKSPACE_ARCHIVE_IO_BUFFER_BYTES }), { signal: input.signal });
    } finally { key.fill(0); }
    const actual = await digestFile(plaintext, input.signal);
    if (actual.sha256 !== wrapped.plaintextSha256 || actual.byteSize !== wrapped.plaintextBytes) failure("plaintext_hash_mismatch");
    // Publish a complete file without replacing an existing destination. A
    // failed/cancelled relay cannot leave a plaintext cache that looks complete.
    const staged = path.join(path.dirname(input.targetPath), `.workspace-snapshot-${randomUUID()}.tmp`);
    try {
      await pipeline(createReadStream(plaintext, { signal: input.signal, highWaterMark: WORKSPACE_ARCHIVE_IO_BUFFER_BYTES }), createWriteStream(staged, { flags: "wx", mode: 0o600, highWaterMark: WORKSPACE_ARCHIVE_IO_BUFFER_BYTES }), { signal: input.signal });
      input.signal?.throwIfAborted(); await link(staged, input.targetPath);
    } finally { await rm(staged, { force: true }); }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
