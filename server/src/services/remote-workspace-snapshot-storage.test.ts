import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { appendFileSync, readdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { applyPendingMigrations, closeRegisteredClients, createDb, executionWorkspaceSnapshots } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { beginWorkspaceSnapshot, getWorkspaceSnapshot, loadWorkspaceSnapshotArchive, recoverWorkspaceSnapshotArchive, uploadWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";

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
  async function fixture() {
    const companyId = randomUUID(), workspaceId = randomUUID(), operationId = randomUUID();
    const cwd = path.join(root, "source"), archivePath = path.join(root, "archive.pcws"); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "saved.txt"), "acknowledged workspace content\n");
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
    const f = await fixture(), ref = await uploadWorkspaceSnapshot(f.upload);
    const ciphertext = await fs.readFile(path.join(root, "objects", ref.objectKey));
    const controller = new AbortController();
    let produced = 0, closed = false;
    const body = new Readable({
      highWaterMark: 1,
      read() {
        if (produced === 2) { controller.abort(new Error("client disconnected")); return; }
        this.push(ciphertext.subarray(produced, ++produced));
      },
      destroy(error, callback) { closed = true; callback(error); },
    });
    storage.getObject = vi.fn(async (_companyId, _objectKey, options) => {
      expect(options?.signal).toBe(controller.signal);
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
});
