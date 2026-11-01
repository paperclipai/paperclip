import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { and, eq } from "drizzle-orm";
import { executionWorkspaceSnapshots, type Db } from "@paperclipai/db";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import type { StorageService } from "../storage/types.js";
import { notifyRemoteWorkspaceSnapshots, REMOTE_WORKSPACE_SNAPSHOT_GRACE_MS } from "./remote-workspace-snapshot-retention.js";

const SCHEMA = "paperclip.workspace-snapshot.v1";
const KEY_SCHEMA = "paperclip.workspace-snapshot-key.v1";
const MAGIC = Buffer.from("PCWSE1\n");
const FORMAT = "paperclip.remote-workspace-archive.v1";
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
  for await (const part of createReadStream(file, { signal })) { digest.update(part); byteSize += part.length; }
  return { sha256: digest.digest("hex"), byteSize };
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

/** Upload attempts are journaled before remote I/O. The caller owns publication. */
export async function uploadWorkspaceSnapshot(input: {
  db: Db; storage: StorageService; snapshotId: string; companyId: string; workspaceId: string;
  archivePath: string; manifestDigest: string; signal?: AbortSignal;
}): Promise<WorkspaceSnapshotRef> {
  const [row] = await input.db.select().from(executionWorkspaceSnapshots).where(scope(input));
  if (!row) failure("missing");
  if (["uploaded", "committed", "superseded"].includes(row!.status)) {
    const saved = reference(row!);
    if (saved.manifestDigest !== input.manifestDigest) failure("operation_content_changed");
    await verifyObject(input.storage, saved, input.signal); return saved;
  }
  if (row!.status !== "pending" || !/^[a-f0-9]{64}$/.test(input.manifestDigest)) failure("not_writable");
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
    if (saved.manifestDigest !== input.manifestDigest) failure("operation_content_changed");
    return saved;
  };
  // Recover a completed upload even when the previous process lost its reply
  // and its scratch directory. Failed attempts remain referenced for cleanup.
  const attempts = Array.isArray(row!.metadata?.uploads) ? row!.metadata!.uploads as UploadAttempt[] : [];
  for (const attempt of attempts) {
    if (attempt.manifestDigest !== input.manifestDigest) failure("operation_content_changed");
    const ref = { schema: SCHEMA, ...identity, ...attempt } as WorkspaceSnapshotRef;
    validateReference(ref);
    if ((await input.storage.headObject(ref.companyId, ref.objectKey, { signal: input.signal })).exists) {
      await verifyObject(input.storage, ref, input.signal); return publish(attempt);
    }
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), "pc-workspace-encrypt-"));
  try {
    const encrypted = path.join(scratch, "archive.encrypted"), dataKey = randomBytes(32), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv); cipher.setAAD(aad(identity));
    const plaintext = await digestFile(input.archivePath, input.signal);
    const { material } = await localEncryptedProvider.createVersion({ value: JSON.stringify({ schema: KEY_SCHEMA,
      ...identity, dataKey: dataKey.toString("base64"), plaintextSha256: plaintext.sha256, plaintextBytes: plaintext.byteSize }) });
    const header = await open(encrypted, "wx", 0o600);
    try { await header.writeFile(Buffer.concat([MAGIC, iv])); } finally { await header.close(); }
    const incomingDigest = createHash("sha256"); let incomingBytes = 0;
    const observed = new Transform({ transform(bytes, _encoding, callback) { incomingDigest.update(bytes); incomingBytes += bytes.length; callback(null, bytes); } });
    await pipeline(createReadStream(input.archivePath, { signal: input.signal }), observed, cipher, createWriteStream(encrypted, { flags: "a", mode: 0o600 }), { signal: input.signal });
    if (incomingBytes !== plaintext.byteSize || incomingDigest.digest("hex") !== plaintext.sha256) failure("archive_changed");
    const footer = await open(encrypted, "a"); try { await footer.writeFile(cipher.getAuthTag()); } finally { await footer.close(); }
    dataKey.fill(0);
    const content = await digestFile(encrypted, input.signal);
    const attempt: UploadAttempt = { objectKey: `${identity.companyId}/workspace-snapshots/${identity.workspaceId}/${identity.id}/${randomUUID()}.pcws`,
      ...content, key: material, manifestDigest: input.manifestDigest };
    const recorded = await input.db.transaction(async tx => {
      const [current] = await tx.select().from(executionWorkspaceSnapshots).where(scope(input)).for("update");
      if (!current || current.status !== "pending") return false;
      const previous = Array.isArray(current.metadata?.uploads) ? current.metadata.uploads : [];
      await notifyRemoteWorkspaceSnapshots(tx, `workspace:${input.workspaceId}`);
      await tx.update(executionWorkspaceSnapshots).set({ metadata: { ...current.metadata, uploads: [...previous, attempt] }, updatedAt: new Date() }).where(scope(input));
      return true;
    });
    if (!recorded) {
      const saved = await getWorkspaceSnapshot(input.db, input);
      if (!saved || saved.manifestDigest !== input.manifestDigest) failure("publication_changed");
      await verifyObject(input.storage, saved, input.signal); return saved;
    }
    // The object key is unique per attempt, so a late losing uploader cannot
    // overwrite an object already used by a committed generation.
    await input.storage.putFile({ companyId: identity.companyId, namespace: "workspace-snapshots", objectKey: attempt.objectKey,
      originalFilename: null, contentType: "application/octet-stream", body: createReadStream(encrypted),
      byteSize: attempt.byteSize, sha256: attempt.sha256, signal: input.signal });
    await verifyObject(input.storage, { schema: SCHEMA, ...identity, ...attempt } as WorkspaceSnapshotRef, input.signal);
    return await publish(attempt);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Authentication finishes in private scratch before any plaintext is published. */
export async function loadWorkspaceSnapshotArchive(input: {
  storage: StorageService; reference: WorkspaceSnapshotRef; targetPath: string; signal?: AbortSignal; temporaryParent?: string;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const ref = input.reference; validateReference(ref);
  const wrapped = JSON.parse(await localEncryptedProvider.resolveVersion({ material: ref.key, externalRef: null }));
  if (wrapped.schema !== KEY_SCHEMA || wrapped.companyId !== ref.companyId || wrapped.workspaceId !== ref.workspaceId
    || wrapped.id !== ref.id || wrapped.generation !== ref.generation || !/^[a-f0-9]{64}$/.test(wrapped.plaintextSha256 ?? "")
    || !Number.isSafeInteger(wrapped.plaintextBytes) || wrapped.plaintextBytes < 0) failure("key_binding_invalid");
  const scratch = await mkdtemp(path.join(input.temporaryParent ?? os.tmpdir(), "pc-workspace-decrypt-"));
  try {
    input.signal?.throwIfAborted();
    const ciphertext = path.join(scratch, "ciphertext"), plaintext = path.join(scratch, "plaintext");
    const object = await input.storage.getObject(ref.companyId, ref.objectKey, { signal: input.signal });
    let received = 0; const digest = createHash("sha256");
    const bounded = new Transform({ transform(bytes, _encoding, callback) {
      received += bytes.length; digest.update(bytes);
      callback(received > ref.byteSize ? new Error("remote_workspace_snapshot_object_size_mismatch") : null, bytes);
    } });
    try { await pipeline(object.stream, bounded, createWriteStream(ciphertext, { flags: "wx", mode: 0o600 }), { signal: input.signal }); }
    finally { object.stream.destroy(); }
    if (received !== ref.byteSize || digest.digest("hex") !== ref.sha256) failure("object_hash_mismatch");
    const file = await open(ciphertext, "r"), header = Buffer.alloc(MAGIC.length + 12), tag = Buffer.alloc(16);
    try { await file.read(header, 0, header.length, 0); await file.read(tag, 0, tag.length, ref.byteSize - tag.length); } finally { await file.close(); }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) failure("ciphertext_header_invalid");
    const key = Buffer.from(wrapped.dataKey, "base64"); if (key.length !== 32) failure("key_invalid");
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
    decipher.setAAD(aad(ref)); decipher.setAuthTag(tag);
    try {
      await pipeline(createReadStream(ciphertext, { start: header.length, end: ref.byteSize - tag.length - 1, signal: input.signal }),
        decipher, createWriteStream(plaintext, { flags: "wx", mode: 0o600 }), { signal: input.signal });
    } finally { key.fill(0); }
    const actual = await digestFile(plaintext, input.signal);
    if (actual.sha256 !== wrapped.plaintextSha256 || actual.byteSize !== wrapped.plaintextBytes) failure("plaintext_hash_mismatch");
    // Publish a complete file without replacing an existing destination. A
    // failed/cancelled relay cannot leave a plaintext cache that looks complete.
    const staged = path.join(path.dirname(input.targetPath), `.workspace-snapshot-${randomUUID()}.tmp`);
    try {
      await pipeline(createReadStream(plaintext, { signal: input.signal }), createWriteStream(staged, { flags: "wx", mode: 0o600 }), { signal: input.signal });
      input.signal?.throwIfAborted(); await link(staged, input.targetPath);
    } finally { await rm(staged, { force: true }); }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
