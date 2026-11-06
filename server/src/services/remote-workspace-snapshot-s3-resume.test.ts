import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, closeRegisteredClients, createDb, executionWorkspaceSnapshots } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { beginWorkspaceSnapshot, loadWorkspaceSnapshotArchive, uploadWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";

// Restart recovery restores a saved workspace by streaming its encrypted
// snapshot from S3. A reset partway through that body used to fail the run.

const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
if (externalDatabaseUrl && !/^remote_workspace_[a-z_]*test$/.test(new URL(externalDatabaseUrl).pathname.slice(1))) {
  throw new Error("Workspace storage tests require a disposable remote_workspace_*test database");
}
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Remote workspace snapshot S3 resume tests unavailable: ${support.reason}`);
suite("remote workspace snapshot restore through S3", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
  beforeAll(async () => {
    if (externalDatabaseUrl) { await applyPendingMigrations(externalDatabaseUrl); db = createDb(externalDatabaseUrl); }
    else { database = await startEmbeddedPostgresTestDatabase("workspace-snapshot-s3-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => { if (externalDatabaseUrl) await closeRegisteredClients(externalDatabaseUrl); else await database?.cleanup(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "41".repeat(32));
    vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret-key");
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-s3-resume-test-"));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await db.delete(executionWorkspaceSnapshots); await fs.rm(root, { recursive: true, force: true }); });

  it("restores a saved workspace when the object body is cut off mid-download", async () => {
    const companyId = randomUUID(), workspaceId = randomUUID(), operationId = randomUUID();
    const cwd = path.join(root, "source"), archivePath = path.join(root, "archive.pcws"); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "saved.txt"), "acknowledged workspace content\n");
    const captured = await captureRemoteWorkspaceDirectory({ cwd, archivePath });
    const row = await beginWorkspaceSnapshot(db, { companyId, workspaceId, operationId, generation: 1, epoch: 3 });
    const local = createStorageService(createLocalDiskStorageProvider(path.join(root, "objects")));
    const ref = await uploadWorkspaceSnapshot({ db, storage: local, snapshotId: row.id, companyId, workspaceId, archivePath, manifestDigest: captured.manifestDigest });
    const ciphertext = await fs.readFile(path.join(root, "objects", ref.objectKey));

    const requests: Array<{ range: string | undefined; ifMatch: string | undefined }> = [];
    // An S3 endpoint that resets the first GetObject body after 40 bytes.
    const server = createServer((req, res) => {
      requests.push({ range: req.headers.range, ifMatch: req.headers["if-match"] as string | undefined }); req.resume();
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      if (range && req.headers["if-match"] !== "\"saved-etag\"") { res.writeHead(412); res.end(); return; }
      const body = range ? ciphertext.subarray(Number(range[1]), Number(range[2]) + 1) : ciphertext;
      res.writeHead(range ? 206 : 200, { "content-type": "application/octet-stream", "content-length": String(body.length), etag: "\"saved-etag\"" });
      if (range) res.end(body); else res.write(body.subarray(0, 40), () => req.socket.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const s3 = createStorageService(createS3StorageProvider({ bucket: "bucket", region: "us-east-1", forcePathStyle: true,
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
      const restoredArchive = path.join(root, "restored.pcws"), targetDir = path.join(root, "restored");
      await loadWorkspaceSnapshotArchive({ storage: s3, reference: ref, targetPath: restoredArchive });
      await restoreRemoteWorkspaceArchive({ archivePath: restoredArchive, targetDir, expectedManifestDigest: ref.manifestDigest });

      expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("acknowledged workspace content\n");
      expect(requests).toEqual([
        { range: undefined, ifMatch: undefined },
        { range: `bytes=40-${ciphertext.length - 1}`, ifMatch: "\"saved-etag\"" },
      ]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
