import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { applyPendingMigrations, closeRegisteredClients, createDb, executionWorkspaceSnapshots } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { beginWorkspaceSnapshot, getWorkspaceSnapshot, loadWorkspaceSnapshotArchive, uploadWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";

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
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-store-test-"));
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
    try { await object.write(Buffer.from("X"), 0, 1, 15); } finally { await object.close(); }
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
});
