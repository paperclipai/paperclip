import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { minioBinary, objectStoreServerEnvironment, startMinio } from "./object-store.js";
import { startStorageFaultProxy } from "./storage-proxy.js";

const binary = minioBinary();

describe("object store", () => {
  it("points the server's storage settings at the given endpoint, path-style", () => {
    expect(objectStoreServerEnvironment({ bucket: "b", region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" }, "http://127.0.0.1:9", "chaos/w1/"))
      .toEqual({ PAPERCLIP_STORAGE_PROVIDER: "s3", PAPERCLIP_STORAGE_S3_BUCKET: "b", PAPERCLIP_STORAGE_S3_REGION: "us-east-1",
        PAPERCLIP_STORAGE_S3_ENDPOINT: "http://127.0.0.1:9", PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE: "true", PAPERCLIP_STORAGE_S3_PREFIX: "chaos/w1/",
        AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "", AWS_CREDENTIAL_EXPIRATION: "", AWS_EC2_METADATA_DISABLED: "true" });
  });

  it("fails fast with the binary's path when MinIO cannot start", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-minio-bad-"));
    try {
      const started = Date.now();
      await expect(startMinio({ binary: path.join(root, "not-a-binary"), root, readyTimeoutMs: 20_000 })).rejects.toThrow(/could not start from .*not-a-binary/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(!binary)("starts a loopback MinIO that honours conditional writes through the fault proxy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-minio-"));
    const store = await startMinio({ binary: binary!, root });
    const proxy = await startStorageFaultProxy(store.endpoint);
    const { S3Client, PutObjectCommand } = createRequire(new URL("../../server/package.json", import.meta.url))("@aws-sdk/client-s3");
    const client = new S3Client({ endpoint: proxy.endpoint, region: store.region, forcePathStyle: true,
      credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey } });
    try {
      await client.send(new PutObjectCommand({ Bucket: store.bucket, Key: "a", Body: "1", IfNoneMatch: "*" }));
      await expect(client.send(new PutObjectCommand({ Bucket: store.bucket, Key: "a", Body: "2", IfNoneMatch: "*" })))
        .rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
      proxy.setRules([{ fault: { kind: "outage" }, methods: ["PUT"], remaining: 10 }]);
      await expect(client.send(new PutObjectCommand({ Bucket: store.bucket, Key: "b", Body: "3" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 503 } });
      expect(proxy.counts().injected).toBeGreaterThanOrEqual(1);
    } finally {
      client.destroy();
      await proxy.close();
      await store.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
