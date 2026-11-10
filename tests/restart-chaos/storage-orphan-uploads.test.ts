import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createS3StorageProvider } from "../../server/src/storage/s3-provider.js";
import { minioBinary, startMinio, type ObjectStore } from "./object-store.js";
import { listIncompleteUploads } from "./storage-audit.js";

const binary = minioBinary();
const sdk = createRequire(new URL("../../server/package.json", import.meta.url))("@aws-sdk/client-s3");
const MIB = 1024 * 1024;

describe.skipIf(!binary)("incomplete snapshot uploads against MinIO", () => {
  let root: string;
  let store: ObjectStore;
  let client: InstanceType<typeof sdk.S3Client>;
  const prefix = "chaos/w-orphan";
  const snapshot = "company/workspace-snapshots/ws/snapshot";

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-orphan-"));
    store = await startMinio({ binary: binary!, root });
    client = new sdk.S3Client({ endpoint: store.endpoint, region: store.region, forcePathStyle: true, maxAttempts: 1,
      credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey } });
  }, 60_000);
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => {
    client?.destroy();
    await store?.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function cutUpload(key: string) {
    const { UploadId } = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket: store.bucket, Key: `${prefix}/${key}` }));
    await client.send(new sdk.UploadPartCommand({ Bucket: store.bucket, Key: `${prefix}/${key}`, UploadId, PartNumber: 1, Body: Buffer.alloc(5 * MIB, 1) }));
    return UploadId as string;
  }

  it("aborts only the cut-off attempt's uploads and leaves a sibling attempt and a longer key alone", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", store.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", store.secretAccessKey);
    vi.stubEnv("AWS_SESSION_TOKEN", "");
    const cut = `${snapshot}/cut.pcws`, sibling = `${snapshot}/sibling.pcws`, longer = `${snapshot}/cut.pcws.longer`;
    await cutUpload(cut); await cutUpload(cut);
    const siblingId = await cutUpload(sibling), longerId = await cutUpload(longer);
    expect(await listIncompleteUploads(store, `${prefix}/`)).toHaveLength(4);
    const provider = createS3StorageProvider({ bucket: store.bucket, region: store.region, endpoint: store.endpoint, prefix, forcePathStyle: true });
    expect(await provider.abortIncompleteUploads!({ objectKey: cut })).toBe(2);
    expect((await listIncompleteUploads(store, `${prefix}/`)).map(upload => [upload.key, upload.uploadId]).sort())
      .toEqual([[`${prefix}/${longer}`, longerId], [`${prefix}/${sibling}`, siblingId]].sort());
    expect(await provider.abortIncompleteUploads!({ objectKey: cut })).toBe(0);
  }, 60_000);
});
