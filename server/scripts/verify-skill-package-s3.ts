/** Disposable, loopback-only S3 compatibility check. No application data is used. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { S3Client, CreateBucketCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { companies, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createStorageService } from "../src/storage/service.js";
import { createS3StorageProvider } from "../src/storage/s3-provider.js";
import { skillPackagePaths, skillPackageStore } from "../src/services/skill-package-store.js";
import { skillSnapshotHash } from "../src/services/skill-snapshot.js";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";

const endpoint = process.env.PAPERCLIP_SKILL_PACKAGE_TEST_S3_ENDPOINT;
assert.ok(endpoint, "Set PAPERCLIP_SKILL_PACKAGE_TEST_S3_ENDPOINT to a disposable loopback S3 server");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname), "Only loopback test storage is allowed");
const region = "us-east-1", bucket = `skill-package-test-${randomUUID()}`;
const client = new S3Client({ region, endpoint, forcePathStyle: true });
const database = await startEmbeddedPostgresTestDatabase("skill-package-s3-");
const db = createDb(database.connectionString);
const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-package-s3-"));
const previousHome = process.env.PAPERCLIP_HOME;
process.env.PAPERCLIP_HOME = home;
const storage = createStorageService(createS3StorageProvider({ bucket, region, endpoint, forcePathStyle: true }));
const companyId = randomUUID();
const keys: string[] = [];
let bucketCreated = false;
try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  bucketCreated = true;
  await db.insert(companies).values({ id: companyId, name: "Disposable S3 check", issuePrefix: "S3T" });
  const files: CompanySkillVersionFileInventoryEntry[] = [
    { path: "SKILL.md", kind: "skill", content: "---\nname: s3-check\ndescription: Disposable compatibility check\n---\nTest only.\n" },
    ...Array.from({ length: 20 }, (_, index) => ({ path: `assets/${index}.bin`, kind: "asset" as const,
      content: randomBytes(900_000).toString("base64"), encoding: "base64" as const })),
    { path: "scripts/check.sh", kind: "script", content: "#!/bin/sh\nexit 0\n", executable: true },
  ];
  const store = skillPackageStore(db, storage);
  const id = await store.prepare(companyId, files);
  const receipt = (await store.descriptor(companyId, id)).storage!;
  keys.push(receipt.archiveKey, receipt.manifestKey);
  assert.ok(receipt.archiveBytes > 16 * 1024 * 1024, "Exercise at least three multipart upload parts");
  assert.equal(skillSnapshotHash(await store.files(companyId, id)), skillSnapshotHash(files));
  await fs.rm(skillPackagePaths(companyId, id).directory, { recursive: true });
  assert.equal(skillSnapshotHash(await store.files(companyId, id)), skillSnapshotHash(files));
  assert.equal(await store.verifyDurable(companyId, id), true);
  console.log(JSON.stringify({ provider: "s3", files: files.length, archiveBytes: receipt.archiveBytes,
    decodedBytes: receipt.totalBytes, multipartRoundTrip: true, coldRestore: true, verifiedDurable: true }));
} finally {
  await Promise.allSettled(keys.map(key => storage.deleteObject(companyId, key)));
  if (bucketCreated) await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(error => console.error("Disposable bucket cleanup failed", error));
  client.destroy();
  await db.$client.end({ timeout: 1 });
  await database.cleanup();
  await fs.rm(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousHome;
}
