import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { Readable } from "node:stream";
import { appendFileSync, readdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { applyPendingMigrations, closeRegisteredClients, createDb, executionWorkspaceSnapshots } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";

import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { withS3FailureDiagnostics } from "../storage/s3-failure.js";
import { isStorageUnavailableError, reportStorageOutageWaitsTo, runInOwnStorageScope, sendThroughStorageOutage } from "../storage/storage-unavailable.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { beginWorkspaceSnapshot, getWorkspaceSnapshot, loadWorkspaceSnapshotArchive, newWorkspaceSnapshotStorageTiming, recoverWorkspaceSnapshotArchive, uploadWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";

// Pass-through, so one test can report a changed archive between the two
// identity reads that bracket encryption.
const lstatOverride = vi.hoisted(() => ({ current: null as null | ((file: string, real: (file: string) => Promise<import("node:fs").Stats>) => Promise<import("node:fs").Stats>) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = ((file: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => lstatOverride.current
    ? lstatOverride.current(String(file), target => actual.lstat(target))
    : (actual.lstat as (...args: unknown[]) => unknown)(file, ...rest)) as typeof actual.lstat;
  return { ...actual, lstat, default: { ...actual, lstat } };
});

const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
if (externalDatabaseUrl && !/^remote_workspace_[a-z_]*test$/.test(new URL(externalDatabaseUrl).pathname.slice(1))) {
  throw new Error("Workspace storage tests require a disposable remote_workspace_*test database");
}
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Remote workspace snapshot DB tests unavailable: ${support.reason}`);
suite("remote workspace snapshot storage", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  let root: string, storage: StorageService;
  beforeAll(async () => {
    if (externalDatabaseUrl) { await applyPendingMigrations(externalDatabaseUrl); db = createDb(externalDatabaseUrl); }
    else { database = await startEmbeddedPostgresTestDatabase("workspace-snapshot-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => { if (externalDatabaseUrl) await closeRegisteredClients(externalDatabaseUrl); else await database?.cleanup(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "41".repeat(32));
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-store-test-")));
    storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "objects")));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await db.delete(executionWorkspaceSnapshots); await fs.rm(root, { recursive: true, force: true }); });
  async function fixture(content: string | Buffer = "acknowledged workspace content\n") {
    const companyId = randomUUID(), workspaceId = randomUUID(), operationId = randomUUID();
    const cwd = path.join(root, "source"), archivePath = path.join(root, "archive.pcws"); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "saved.txt"), content);
    const captured = await captureRemoteWorkspaceDirectory({ cwd, archivePath });
    const row = await beginWorkspaceSnapshot(db, { companyId, workspaceId, operationId, generation: 1, epoch: 3 });
    const upload = { db, storage, snapshotId: row.id, companyId, workspaceId, archivePath, manifestDigest: captured.manifestDigest };
    return { companyId, workspaceId, operationId, cwd, archivePath, captured, row, upload };
  }
  it("streams encrypted saved data through the real ledger and filesystem object backend", async () => {
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload);
    expect(ref.byteSize).toBeGreaterThan(f.captured.byteSize);
    const object = await storage.getObject(f.companyId, ref.objectKey); const parts: Buffer[] = [];
    for await (const part of object.stream) parts.push(part);
    expect(Buffer.concat(parts).includes(Buffer.from("acknowledged workspace content"))).toBe(false);
    await fs.rm(f.cwd, { recursive: true }); await fs.rm(f.archivePath);
    const restoredArchive = path.join(root, "restored.pcws"), targetDir = path.join(root, "restored");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath: restoredArchive });
    await restoreRemoteWorkspaceArchive({ archivePath: restoredArchive, targetDir, expectedManifestDigest: ref.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("acknowledged workspace content\n");
    const [row] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, ref.id));
    expect(row?.status).toBe("uploaded"); // The owning service still controls atomic publication.
  });
  it.each(["uploaded", "lost-reply"])("refuses an unreadable %s snapshot key without downloading", async state => {
    const f = await fixture(), put = storage.putFile.bind(storage);
    if (state === "lost-reply") {
      storage.putFile = async input => { await put(input); throw new Error("lost upload reply"); };
      await expect(uploadWorkspaceSnapshot({ ...f.upload, verification: "upload" })).rejects.toThrow("lost upload reply");
      storage.putFile = put;
    } else await uploadWorkspaceSnapshot({ ...f.upload, verification: "upload" });
    await fs.rm(f.archivePath);
    const get = vi.spyOn(storage, "getObject").mockRejectedValue(new Error("must not download"));
    const upload = vi.spyOn(storage, "putFile");
    const [before] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.row.id));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "42".repeat(32));
    await expect(uploadWorkspaceSnapshot({ ...f.upload, verification: "upload" })).rejects.toThrow();
    const [after] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.row.id));
    expect(after).toEqual(before);
    expect(get).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  });
  it("records where a save and a restore spend their time", async () => {
    const f = await fixture();
    const saveTiming = newWorkspaceSnapshotStorageTiming();
    const ref = await uploadWorkspaceSnapshot({ ...f.upload, timing: saveTiming });
    const step = expect.any(Number);
    expect(saveTiming).toMatchObject({ priorAttemptCheckMs: step, encryptMs: step, digestMs: step, putMs: step, verifyMs: step,
      bytes: ref.byteSize });
    const restoreTiming = newWorkspaceSnapshotStorageTiming();
    await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath: path.join(root, "timed.pcws"), timing: restoreTiming });
    expect(restoreTiming).toMatchObject({ downloadMs: step, decryptMs: step, plaintextVerifyMs: step, publishMs: step,
      bytes: ref.byteSize });
  });

  it("times the read-back of an earlier upload that a retried save reuses", async () => {
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload);
    const retry = newWorkspaceSnapshotStorageTiming();
    await uploadWorkspaceSnapshot({ ...f.upload, timing: retry });
    expect(retry).toMatchObject({ verifyMs: expect.any(Number), bytes: ref.byteSize });
    expect(retry.putMs).toBeUndefined();
  });

  it("preserves multi-chunk archive bytes through encryption, authenticated readback, and cold restore", async () => {
    const content = randomBytes(3 * 1024 * 1024 + 137), f = await fixture(content);
    const verifiedArchivePath = path.join(root, "verified-large.pcws");
    const ref = await uploadWorkspaceSnapshot({ ...f.upload, verifiedArchivePath });
    expect((await fs.readFile(verifiedArchivePath)).equals(await fs.readFile(f.archivePath))).toBe(true);
    await fs.rm(f.cwd, { recursive: true }); await fs.rm(f.archivePath);
    const restoredArchive = path.join(root, "cold-large.pcws"), targetDir = path.join(root, "cold-large");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath: restoredArchive });
    expect((await fs.readFile(restoredArchive)).equals(await fs.readFile(verifiedArchivePath))).toBe(true);
    await restoreRemoteWorkspaceArchive({ archivePath: restoredArchive, targetDir, expectedManifestDigest: ref.manifestDigest });
    expect((await fs.readFile(path.join(targetDir, "saved.txt"))).equals(content)).toBe(true);
  });
  it.each(["fresh", "uploaded", "lost-reply"])("reuses one authenticated %s readback for a complete cold restore", async state => {
    const f = await fixture(), put = storage.putFile.bind(storage);
    if (state === "uploaded") await uploadWorkspaceSnapshot(f.upload);
    if (state === "lost-reply") {
      storage.putFile = async input => { await put(input); throw new Error("lost upload reply"); };
      await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("lost upload reply");
      storage.putFile = put;
    }
    const get = vi.spyOn(storage, "getObject"), verifiedArchivePath = path.join(root, "verified.pcws");
    const request = { ...f.upload, verifiedArchivePath }, ref = await uploadWorkspaceSnapshot(request);
    if (!await fs.lstat(verifiedArchivePath).catch(() => null))
      await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath: verifiedArchivePath });
    expect(get).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(verifiedArchivePath)).toEqual(await fs.readFile(f.archivePath));
    expect((await fs.stat(verifiedArchivePath)).mode & 0o777).toBe(0o600);
    expect(await getWorkspaceSnapshot(db, { ...f, snapshotId: ref.id })).toEqual(ref);
    await fs.rm(f.cwd, { recursive: true }); await fs.rm(f.archivePath);
    await restoreRemoteWorkspaceArchive({ archivePath: verifiedArchivePath, targetDir: path.join(root, "cold"), expectedManifestDigest: ref.manifestDigest });
    expect(await fs.readFile(path.join(root, "cold", "saved.txt"), "utf8")).toBe("acknowledged workspace content\n");
    expect((await fs.readdir(root)).some(name => name.startsWith(".workspace-upload-readback-"))).toBe(false);
  });
  it.each(["existing", "public-parent", "linked-parent"])("refuses a caller-owned readback path with %s ownership", async mode => {
    const f = await fixture(), parent = path.join(root, "destination"); await fs.mkdir(parent, { mode: 0o700 });
    let verifiedArchivePath = path.join(parent, "archive.pcws");
    if (mode === "existing") await fs.writeFile(verifiedArchivePath, "keep caller bytes");
    if (mode === "public-parent") await fs.chmod(parent, 0o755);
    if (mode === "linked-parent") {
      const alias = path.join(root, "alias"); await fs.symlink(parent, alias); verifiedArchivePath = path.join(alias, "archive.pcws");
    }
    const get = vi.spyOn(storage, "getObject"), put = vi.spyOn(storage, "putFile");
    await expect(uploadWorkspaceSnapshot({ ...f.upload, verifiedArchivePath })).rejects.toThrow("readback_");
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    if (mode === "existing") expect(await fs.readFile(verifiedArchivePath, "utf8")).toBe("keep caller bytes");
    expect((await db.select().from(executionWorkspaceSnapshots))[0].status).toBe("pending");
  });
  it("rejects a tampered verified plaintext before publishing the caller path", async () => {
    const f = await fixture(), verifiedArchivePath = path.join(root, "tampered.pcws"), debug = db.$client.options.debug;
    let changed = false;
    db.$client.options.debug = (_connection, query) => {
      if (changed || !query.startsWith('update "execution_workspace_snapshots"') || !query.includes('"status" =')) return;
      const directory = readdirSync(root).find(name => name.startsWith(".workspace-upload-readback-"));
      if (!directory) return;
      const file = readdirSync(path.join(root, directory)).find(name => name.endsWith(".pcws"));
      if (file) { appendFileSync(path.join(root, directory, file), "changed plaintext"); changed = true; }
    };
    try {
      await expect(uploadWorkspaceSnapshot({ ...f.upload, verifiedArchivePath })).rejects.toThrow("readback_file_changed");
      expect(changed).toBe(true);
      expect(await fs.lstat(verifiedArchivePath).catch(() => null)).toBeNull();
      expect((await fs.readdir(root)).some(name => name.startsWith(".workspace-upload-readback-"))).toBe(false);
    } finally { db.$client.options.debug = debug; }
  });
  it("keeps GCM authentication mandatory for an uploaded readback and removes all failed plaintext", async () => {
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload), verifiedArchivePath = path.join(root, "bad-key.pcws");
    const wrapped = JSON.parse(await localEncryptedProvider.resolveVersion({ material: ref.key, externalRef: null }));
    const { material } = await localEncryptedProvider.createVersion({ value: JSON.stringify({ ...wrapped, dataKey: Buffer.alloc(32, 8).toString("base64") }) });
    await db.update(executionWorkspaceSnapshots).set({ key: material }).where(eq(executionWorkspaceSnapshots.id, ref.id));
    await expect(uploadWorkspaceSnapshot({ ...f.upload, verifiedArchivePath })).rejects.toThrow();
    expect(await fs.lstat(verifiedArchivePath).catch(() => null)).toBeNull();
    expect((await fs.readdir(root)).some(name => name.startsWith(".workspace-upload-readback-"))).toBe(false);
  });
  it("confirms only the stored size when the backend verified every uploaded part", async () => {
    const f = await fixture(randomBytes(2 * 1024 * 1024 + 91)); const put = storage.putFile.bind(storage);
    let sourceFile: string | undefined;
    storage.putFile = async input => {
      sourceFile = "sourceFile" in input ? input.sourceFile : undefined;
      return { ...await put(input), integrity: "server_verified_md5" };
    };
    const get = vi.spyOn(storage, "getObject"), head = vi.spyOn(storage, "headObject");
    const ref = await uploadWorkspaceSnapshot(f.upload);
    expect(sourceFile).toMatch(/archive\.encrypted$/);
    expect(get).not.toHaveBeenCalled();
    expect(head).toHaveBeenCalledWith(f.companyId, ref.objectKey, expect.anything());
    const restoredArchive = path.join(root, "restored-verified.pcws");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath: restoredArchive });
    expect((await fs.readFile(restoredArchive)).equals(await fs.readFile(f.archivePath))).toBe(true);
  });
  it("still reads back a server-verified upload when the caller keeps the read-back file", async () => {
    const f = await fixture(); const put = storage.putFile.bind(storage);
    storage.putFile = async input => ({ ...await put(input), integrity: "server_verified_md5" });
    const get = vi.spyOn(storage, "getObject"), verifiedArchivePath = path.join(root, "kept.pcws");
    await uploadWorkspaceSnapshot({ ...f.upload, verifiedArchivePath });
    expect(get).toHaveBeenCalled();
    expect((await fs.readFile(verifiedArchivePath)).equals(await fs.readFile(f.archivePath))).toBe(true);
  });
  it("rejects a server-verified upload whose stored size differs", async () => {
    const f = await fixture(); const put = storage.putFile.bind(storage), head = storage.headObject.bind(storage);
    storage.putFile = async input => ({ ...await put(input), integrity: "server_verified_md5" });
    storage.headObject = async (...args) => { const result = await head(...args); return { ...result, contentLength: (result.contentLength ?? 0) + 1 }; };
    await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("object_size_mismatch");
    const [row] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.row.id));
    expect(row?.status).toBe("pending");
  });
  it("rejects an archive that changes while it is encrypted, before any upload", async () => {
    const f = await fixture(); const put = vi.spyOn(storage, "putFile");
    let reads = 0;
    lstatOverride.current = async (file, real) => {
      const stats = await real(file);
      if (file !== f.archivePath || ++reads < 2) return stats;
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { mtimeMs: stats.mtimeMs + 1 });
    };
    try { await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("archive_changed"); }
    finally { lstatOverride.current = null; }
    expect(reads).toBe(2);
    expect(put).not.toHaveBeenCalled();
  });
  it("reconciles an upload whose reply was lost after object persistence, without the old scratch file", async () => {
    const f = await fixture(); const put = storage.putFile.bind(storage); let loseReply = true;
    storage.putFile = async input => { const result = await put(input); if (loseReply) { loseReply = false; throw new Error("lost upload reply"); } return result; };
    await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("lost upload reply");
    await fs.rm(f.archivePath);
    const ref = await uploadWorkspaceSnapshot(f.upload);
    expect(ref.manifestDigest).toBe(f.captured.manifestDigest);
    expect(await getWorkspaceSnapshot(db, { ...f, snapshotId: ref.id })).toEqual(ref);
    const [row] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, ref.id));
    expect((row?.metadata?.uploads as unknown[]).length).toBe(1);
  });
  it("aborts the incomplete upload of an attempt a restart cut off once a retried save publishes", async () => {
    const f = await fixture(), put = storage.putFile.bind(storage), incomplete = new Set<string>();
    storage.abortIncompleteUploads = vi.fn(async (_companyId: string, key: string) => Number(incomplete.delete(key)));
    storage.putFile = async input => { incomplete.add(input.objectKey!); throw new Error("process killed mid UploadPart"); };
    await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("process killed mid UploadPart");
    const [cut] = [...incomplete];
    storage.putFile = put;
    const ref = await uploadWorkspaceSnapshot(f.upload);
    expect(ref.objectKey).not.toBe(cut);
    expect(storage.abortIncompleteUploads).toHaveBeenCalledTimes(1);
    expect(storage.abortIncompleteUploads).toHaveBeenCalledWith(f.companyId, cut, expect.anything());
    expect(incomplete.size).toBe(0);
    await uploadWorkspaceSnapshot(f.upload);
    expect(storage.abortIncompleteUploads).toHaveBeenCalledTimes(1);
  });
  it("adopts the published save when another uploader aborts this attempt's upload", async () => {
    const f = await fixture(), put = storage.putFile.bind(storage);
    let release!: (error: Error) => void, started!: () => void;
    const gate = new Promise<never>((_resolve, reject) => { release = reject; });
    const blocked = new Promise<void>(resolve => { started = resolve; });
    let first = true, aborted: string | null = null;
    storage.putFile = async input => {
      if (!first) return put(input);
      first = false; aborted = input.objectKey!; started(); return gate;
    };
    storage.abortIncompleteUploads = vi.fn(async (_companyId: string, key: string) => {
      if (key === aborted) release(Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" }));
      return 1;
    });
    const loser = uploadWorkspaceSnapshot(f.upload);
    await blocked;
    const winner = await uploadWorkspaceSnapshot(f.upload);
    expect(storage.abortIncompleteUploads).toHaveBeenCalledWith(f.companyId, aborted, expect.anything());
    expect(await loser).toEqual(winner);
  });
  it("retains an unsuccessful operation and rejects a content-changing retry", async () => {
    const f = await fixture(); storage.putFile = async () => { throw new Error("storage unavailable"); };
    await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("storage unavailable");
    const [row] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.row.id));
    expect(row?.status).toBe("pending"); expect((row?.metadata?.uploads as unknown[]).length).toBe(1);
    await expect(uploadWorkspaceSnapshot({ ...f.upload, manifestDigest: "b".repeat(64) })).rejects.toThrow("operation_content_changed");
  });
  it("recaptures only an unavailable unpublished operation while retaining every attempt", async () => {
    const f = await fixture(), put = storage.putFile.bind(storage);
    storage.putFile = async () => { throw new Error("upload_part InternalError"); };
    await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("upload_part InternalError");
    const [pending] = await db.select().from(executionWorkspaceSnapshots);
    const original = (pending!.metadata!.uploads as Record<string, unknown>[])[0]!;
    await fs.rm(f.archivePath);
    await fs.writeFile(path.join(f.cwd, "saved.txt"), "equivalent logical source, different physical capture\n");
    const captured = await captureRemoteWorkspaceDirectory({ cwd: f.cwd, archivePath: f.archivePath });
    const retry = { ...f.upload, manifestDigest: captured.manifestDigest, unpublishedRecapture: { sourceOperationId: f.operationId } };
    await expect(uploadWorkspaceSnapshot({ ...retry, unpublishedRecapture: { sourceOperationId: randomUUID() } })).rejects.toThrow("operation_binding_changed");
    storage.putFile = put;
    const ref = await uploadWorkspaceSnapshot(retry);
    expect(ref.manifestDigest).toBe(captured.manifestDigest);
    const [saved] = await db.select().from(executionWorkspaceSnapshots);
    expect(saved!.metadata!.uploads).toEqual([original, expect.objectContaining({ objectKey: ref.objectKey, manifestDigest: captured.manifestDigest })]);
    // The capability does not reopen a published snapshot.
    await expect(uploadWorkspaceSnapshot({ ...retry, manifestDigest: f.captured.manifestDigest })).rejects.toThrow("operation_content_changed");
  });
  it("prefers an available prior capture over a different recapture", async () => {
    const f = await fixture(), put = storage.putFile.bind(storage);
    storage.putFile = async input => { await put(input); throw new Error("lost upload reply"); };
    await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("lost upload reply");
    await fs.rm(f.archivePath);
    const ref = await uploadWorkspaceSnapshot({ ...f.upload, manifestDigest: "b".repeat(64), unpublishedRecapture: { sourceOperationId: f.operationId } });
    expect(ref.manifestDigest).toBe(f.captured.manifestDigest);
    expect((await db.select().from(executionWorkspaceSnapshots))[0]!.metadata!.uploads).toHaveLength(1);
  });
  it("rechecks prior objects after encryption before recording a recapture", async () => {
    const f = await fixture(), put = storage.putFile.bind(storage), head = storage.headObject.bind(storage);
    let savedInput!: Parameters<StorageService["putFile"]>[0];
    storage.putFile = async input => {
      const parts: Buffer[] = [];
      for await (const bytes of input.body) parts.push(Buffer.from(bytes));
      savedInput = { ...input, body: Buffer.concat(parts) };
      throw new Error("upload interrupted before persistence");
    };
    await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("upload interrupted before persistence");
    let heads = 0;
    storage.headObject = async (...args) => { if (++heads === 2) await put(savedInput); return head(...args); };
    storage.putFile = put;
    const ref = await uploadWorkspaceSnapshot({ ...f.upload, manifestDigest: "b".repeat(64), unpublishedRecapture: { sourceOperationId: f.operationId } });
    expect(ref.manifestDigest).toBe(f.captured.manifestDigest);
    expect(heads).toBe(2);
    expect((await db.select().from(executionWorkspaceSnapshots))[0]!.metadata!.uploads).toHaveLength(1);
  });
  it("refuses stale recapture admission when another attempt enters the ledger", async () => {
    const f = await fixture(), head = storage.headObject.bind(storage);
    storage.putFile = async () => { throw new Error("upload unavailable"); };
    await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("upload unavailable");
    let ready!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { ready = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    let heads = 0;
    storage.headObject = async (...args) => { if (++heads === 1) { ready(); await resume; } return head(...args); };
    const stale = uploadWorkspaceSnapshot({ ...f.upload, manifestDigest: "b".repeat(64), unpublishedRecapture: { sourceOperationId: f.operationId } });
    try {
      await paused;
      await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("upload unavailable");
      release();
      await expect(stale).rejects.toThrow("upload_attempts_changed");
      const [saved] = await db.select().from(executionWorkspaceSnapshots);
      expect(saved).toMatchObject({ status: "pending", objectKey: null });
      expect(saved!.metadata!.uploads).toHaveLength(2);
    } finally { release(); await Promise.allSettled([stale]); }
  });
  it.each(["unknown", "corrupt"])("refuses recapture when a prior object is %s", async state => {
    const f = await fixture(), put = storage.putFile.bind(storage);
    storage.putFile = async input => { await put(input); throw new Error("lost upload reply"); };
    await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("lost upload reply");
    if (state === "unknown") storage.headObject = async () => { throw new Error("HEAD unavailable"); };
    else {
      const [pending] = await db.select().from(executionWorkspaceSnapshots);
      const [attempt] = pending!.metadata!.uploads as { objectKey: string }[];
      await fs.writeFile(path.join(root, "objects", attempt!.objectKey), "corrupt object");
    }
    await expect(uploadWorkspaceSnapshot({ ...f.upload, manifestDigest: "b".repeat(64), unpublishedRecapture: { sourceOperationId: f.operationId } }))
      .rejects.toThrow(state === "unknown" ? "HEAD unavailable" : "object_hash_mismatch");
    const [saved] = await db.select().from(executionWorkspaceSnapshots);
    expect(saved).toMatchObject({ status: "pending", objectKey: null });
    expect(saved!.metadata!.uploads).toHaveLength(1);
  });
  it.each(["original", "recapture", "original-with-lost-reply"].flatMap(winner => [false, true].map(readback => ({ winner, readback }))))(
    "keeps a $winner winner when another physical capture finishes late (readback: $readback)", async ({ winner, readback }) => {
    const f = await fixture(), put = storage.putFile.bind(storage);
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(ready => { resolve = ready; });
      return { resolve, promise };
    };
    const originalReady = deferred(), originalRelease = deferred(), recaptureReady = deferred(), recaptureRelease = deferred();
    let calls = 0;
    storage.putFile = async input => {
      const first = ++calls === 1;
      if (first) { originalReady.resolve(); await originalRelease.promise; }
      else { recaptureReady.resolve(); await recaptureRelease.promise; }
      const saved = await put(input);
      if (first && winner === "original-with-lost-reply") throw new Error("late original upload reply lost");
      return saved;
    };
    const unpublishedRecapture = { sourceOperationId: f.operationId };
    const originalPath = path.join(root, "original-verified.pcws"), recapturedPath = path.join(root, "recaptured-verified.pcws");
    const original = uploadWorkspaceSnapshot({ ...f.upload, unpublishedRecapture, ...(readback ? { verifiedArchivePath: originalPath } : {}) });
    let recapture: ReturnType<typeof uploadWorkspaceSnapshot> | undefined;
    try {
      await originalReady.promise;
      const archivePath = path.join(root, "recaptured.pcws");
      await fs.writeFile(path.join(f.cwd, "saved.txt"), "different physical capture\n");
      const captured = await captureRemoteWorkspaceDirectory({ cwd: f.cwd, archivePath });
      recapture = uploadWorkspaceSnapshot({ ...f.upload, archivePath, manifestDigest: captured.manifestDigest, unpublishedRecapture,
        ...(readback ? { verifiedArchivePath: recapturedPath } : {}) });
      await recaptureReady.promise;
      (winner === "recapture" ? recaptureRelease : originalRelease).resolve();
      if (winner === "original-with-lost-reply") {
        await expect(original).rejects.toThrow("late original upload reply lost");
        recaptureRelease.resolve();
      }
      const saved = await (winner === "original" ? original : recapture);
      expect(saved.manifestDigest).toBe(winner === "recapture" ? captured.manifestDigest : f.captured.manifestDigest);
      originalRelease.resolve(); recaptureRelease.resolve();
      if (winner !== "original-with-lost-reply") expect(await original).toEqual(saved);
      expect(await recapture).toEqual(saved);
      if (readback) {
        const winningBytes = await fs.readFile(winner === "recapture" ? archivePath : f.archivePath);
        expect(await fs.readFile(recapturedPath)).toEqual(winningBytes);
        if (winner !== "original-with-lost-reply") expect(await fs.readFile(originalPath)).toEqual(winningBytes);
      }
      expect(await getWorkspaceSnapshot(db, { ...f, snapshotId: f.row.id })).toEqual(saved);
      expect((await db.select().from(executionWorkspaceSnapshots))[0]!.metadata!.uploads).toHaveLength(2);
    } finally { originalRelease.resolve(); recaptureRelease.resolve(); await Promise.allSettled([original, recapture]); }
  });
  it("authenticates a lost-reply archive without publishing its pending upload", async () => {
    const f = await fixture(), put = storage.putFile.bind(storage);
    storage.putFile = async input => { await put(input); throw new Error("lost upload reply"); };
    await expect(uploadWorkspaceSnapshot(f.upload)).rejects.toThrow("lost upload reply");
    await fs.rm(f.archivePath);
    const targetPath = path.join(root, "recovered.pcws");
    const ref = await recoverWorkspaceSnapshotArchive({ ...f.upload, targetPath });
    expect(ref?.manifestDigest).toBe(f.captured.manifestDigest);
    expect((await db.select().from(executionWorkspaceSnapshots))[0]?.status).toBe("pending");
    expect(await getWorkspaceSnapshot(db, { ...f, snapshotId: f.row.id })).toBeNull();
    await restoreRemoteWorkspaceArchive({ archivePath: targetPath, targetDir: path.join(root, "restored"), expectedManifestDigest: ref!.manifestDigest });
    expect(await fs.readFile(path.join(root, "restored", "saved.txt"), "utf8")).toBe("acknowledged workspace content\n");
    await expect(recoverWorkspaceSnapshotArchive({ ...f.upload, companyId: randomUUID(), targetPath: path.join(root, "wrong-company.pcws") }))
      .rejects.toThrow("remote_workspace_snapshot_missing");
  });
  it("keeps operation identity and company/workspace scope exact", async () => {
    const f = await fixture();
    expect((await beginWorkspaceSnapshot(db, { ...f, generation: 1, epoch: 3 })).id).toBe(f.row.id);
    await expect(beginWorkspaceSnapshot(db, { ...f, generation: 1, epoch: 4 })).rejects.toThrow("operation_binding_changed");
    await uploadWorkspaceSnapshot(f.upload);
    expect(await getWorkspaceSnapshot(db, { ...f, snapshotId: f.row.id, companyId: randomUUID() })).toBeNull();
    expect(await getWorkspaceSnapshot(db, { ...f, snapshotId: f.row.id, workspaceId: randomUUID() })).toBeNull();
  });
  it("rejects object corruption and leaves the requested plaintext path unpublished", async () => {
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload);
    const objectPath = path.join(root, "objects", ref.objectKey), object = await fs.open(objectPath, "r+");
    try {
      const byte = Buffer.alloc(1);
      expect((await object.read(byte, 0, 1, 15)).bytesRead).toBe(1);
      byte[0] = byte[0]! ^ 1;
      await object.write(byte, 0, 1, 15);
    } finally { await object.close(); }
    const targetPath = path.join(root, "corrupted.pcws");
    await expect(loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath })).rejects.toThrow("object_hash_mismatch");
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a foreign wrapped key even when ciphertext metadata is unchanged", async () => {
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload);
    const foreignId = randomUUID();
    await expect(loadWorkspaceSnapshotArchive({ storage, reference: { ...ref, id: foreignId, objectKey: ref.objectKey.replace(ref.id, foreignId) },
      targetPath: path.join(root, "foreign.pcws") })).rejects.toThrow("key_binding_invalid");
  });
  it("does not overwrite an existing caller file", async () => {
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload), targetPath = path.join(root, "existing.pcws");
    await fs.writeFile(targetPath, "existing");
    await expect(loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(targetPath, "utf8")).toBe("existing");
  });
  it("does not start object retrieval for an already canceled snapshot load", async () => {
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload);
    const getObject = vi.spyOn(storage, "getObject");
    const controller = new AbortController(), reason = new Error("request already canceled");
    controller.abort(reason);
    const targetPath = path.join(root, "canceled.pcws");
    const error = await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath, signal: controller.signal }).catch(error => error);
    expect(getObject).not.toHaveBeenCalled();
    expect(error).toBe(reason);
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cancels an active object body and removes private decryption scratch before rejecting", async () => {
    const f = await fixture(randomBytes(3 * 1024 * 1024 + 137)), ref = await uploadWorkspaceSnapshot(f.upload);
    const ciphertext = await fs.readFile(path.join(root, "objects", ref.objectKey));
    const controller = new AbortController();
    let produced = 0, reads = 0, closed = false;
    const body = new Readable({
      highWaterMark: 1,
      read() {
        if (reads++ === 2) { controller.abort(new Error("client disconnected")); return; }
        const start = produced; produced += 1024 * 1024 + 17;
        this.push(ciphertext.subarray(start, produced));
      },
      destroy(error, callback) { closed = true; callback(error); },
    });
    storage.getObject = vi.fn(async (_companyId, _objectKey, options) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.signal?.aborted).toBe(false);
      return { stream: body, contentLength: ciphertext.length };
    });
    const scratchRoot = path.join(root, "private-scratch"); await fs.mkdir(scratchRoot);
    const temp = vi.spyOn(os, "tmpdir").mockReturnValue(scratchRoot);
    const targetPath = path.join(root, "interrupted.pcws");
    try {
      await expect(loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath, signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(closed).toBe(true); expect(body.destroyed).toBe(true);
      expect(produced).toBeGreaterThan(0); expect(produced).toBeLessThan(ciphertext.length);
      const atRejection = produced; await new Promise(resolve => setImmediate(resolve)); expect(produced).toBe(atRejection);
      expect(await fs.readdir(scratchRoot)).toEqual([]);
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { temp.mockRestore(); }
  });
  it("tells the run it is waiting for storage while a save or a restore waits out an outage", async () => {
    const f = await fixture();
    const outage = () => withS3FailureDiagnostics("put_object", async () => {
      throw Object.assign(new Error("Injected storage outage"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } });
    });
    let puts = 0, gets = 0, restoring = false;
    const flaky = { ...storage,
      putFile: (input: Parameters<StorageService["putFile"]>[0]) => sendThroughStorageOutage(async () => (++puts < 2 ? outage() : storage.putFile(input))),
      getObject: vi.fn(async (...args: Parameters<StorageService["getObject"]>) => (restoring && ++gets < 2 ? outage() : storage.getObject(...args))),
    } as StorageService;
    const waiting = vi.fn(), ended = vi.fn();
    await runInOwnStorageScope(async () => {
      reportStorageOutageWaitsTo({ waiting, ended });
      const ref = await uploadWorkspaceSnapshot({ ...f.upload, storage: flaky });
      restoring = true;
      await loadWorkspaceSnapshotArchive({ storage: flaky, reference: ref, targetPath: path.join(root, "waited.pcws") });
    });
    expect(waiting.mock.calls.map(([wait]) => wait.purpose)).toEqual(["saving the workspace", "restoring the workspace"]);
    expect(ended.mock.calls.map(([wait]) => [wait.purpose, wait.recovered])).toEqual([["saving the workspace", true], ["restoring the workspace", true]]);
  }, 30_000);
  it("keeps a storage outage as the cause when the download deadline ends its wait", async () => {
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload);
    let requested!: () => void;
    const firstRequest = new Promise<void>(resolve => { requested = resolve; });
    const unavailable = { ...storage, getObject: vi.fn(async () => {
      requested();
      return withS3FailureDiagnostics("get_object", async () => {
        throw Object.assign(new Error("Injected storage outage"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } });
      });
    }) } as StorageService;
    const scratch = path.join(root, "outage-scratch"); await fs.mkdir(scratch);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = loadWorkspaceSnapshotArchive({ storage: unavailable, reference: ref, targetPath: path.join(root, "outage.pcws"),
      temporaryParent: scratch }).then(() => ({ succeeded: true }), (error: unknown) => error);
    try {
      await firstRequest;
      await vi.advanceTimersByTimeAsync(300_001);
      const outcome = await Promise.race([result, wait(2_000).then(() => ({ pending: true }))]);
      expect(isStorageUnavailableError(outcome)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it.each(["headers", "body"])("closes a stalled S3 %s request before returning a retryable download failure", async phase => {
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload);
    const ciphertext = await fs.readFile(path.join(root, "objects", ref.objectKey));
    let ready!: () => void, closed!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    const server = createServer((req, res) => {
      req.socket.once("close", closed);
      if (phase === "headers") { ready(); return; }
      res.writeHead(200, { "content-length": String(ciphertext.length) });
      res.write(ciphertext.subarray(0, 1));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret-key");
    vi.stubEnv("AWS_SESSION_TOKEN", "");
    const remote = createStorageService(createS3StorageProvider({ bucket: "bucket", region: "us-east-1", forcePathStyle: true,
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    const get = remote.getObject.bind(remote);
    remote.getObject = async (...args) => {
      const object = await get(...args);
      object.stream.once("data", ready);
      return object;
    };
    const controller = new AbortController(), targetPath = path.join(root, "stalled.pcws");
    const scratch = path.join(root, "download-scratch"); await fs.mkdir(scratch);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = loadWorkspaceSnapshotArchive({ storage: remote, reference: ref, targetPath,
      signal: controller.signal, temporaryParent: scratch }).then(() => ({ succeeded: true }), error => error);
    try {
      await started;
      await vi.advanceTimersByTimeAsync(300_001);
      const outcome = await Promise.race([result, wait(100).then(() => ({ pending: true }))]);
      expect(outcome).toMatchObject({ name: "TimeoutError", message: "remote_workspace_snapshot_download_stalled" });
      await Promise.race([disconnected, wait(1_000).then(() => { throw new Error("S3 request still connected after timeout"); })]);
      expect(controller.signal.aborted).toBe(false);
      expect(await fs.readdir(scratch)).toEqual([]);
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await getWorkspaceSnapshot(db, { ...f, snapshotId: ref.id })).toEqual(ref);
      await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath });
      expect(await fs.readFile(targetPath)).toEqual(await fs.readFile(f.archivePath));
    } finally {
      controller.abort(); await result;
      vi.useRealTimers(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("lets an S3 download exceed five minutes while bytes keep arriving", async () => {
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload);
    const ciphertext = await fs.readFile(path.join(root, "objects", ref.objectKey));
    let response!: ServerResponse, consumed = 0;
    const observed = Array.from({ length: 4 }, () => {
      let resolve!: () => void;
      const promise = new Promise<void>(ready => { resolve = ready; });
      return { promise, resolve };
    });
    const width = Math.ceil(ciphertext.length / 4);
    const server = createServer((_req, res) => {
      response = res; res.writeHead(200, { "content-length": String(ciphertext.length) });
      res.write(ciphertext.subarray(0, width));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret-key");
    vi.stubEnv("AWS_SESSION_TOKEN", "");
    const remote = createStorageService(createS3StorageProvider({ bucket: "bucket", region: "us-east-1", forcePathStyle: true,
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    const get = remote.getObject.bind(remote);
    remote.getObject = async (...args) => {
      const object = await get(...args);
      object.stream.on("data", () => observed[consumed++]?.resolve());
      return object;
    };
    const controller = new AbortController(), targetPath = path.join(root, "progressing.pcws");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = loadWorkspaceSnapshotArchive({ storage: remote, reference: ref, targetPath, signal: controller.signal });
    const settled = result.catch(error => error);
    try {
      await observed[0]!.promise;
      for (let index = 1; index < 4; index += 1) {
        await vi.advanceTimersByTimeAsync(240_000);
        response.write(ciphertext.subarray(index * width, (index + 1) * width));
        await observed[index]!.promise;
      }
      response.end(); await result;
      expect(await fs.readFile(targetPath)).toEqual(await fs.readFile(f.archivePath));
      await vi.advanceTimersByTimeAsync(300_001);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      controller.abort(); await settled;
      vi.useRealTimers(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
