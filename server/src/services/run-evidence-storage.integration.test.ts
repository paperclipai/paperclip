import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import type { RunLogStore } from "./run-log-store.js";

const endpoint = process.env.PAPERCLIP_LOG_TEST_S3_ENDPOINT;
describe.skipIf(!endpoint)("instance storage for run evidence", () => {
  const buckets = [0, 1].map(() => `pc-evidence-config-${randomUUID()}`);
  const stores: RunLogStore[] = [];
  let client: S3Client, directory: string;
  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), "evidence-config-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(directory, "config.json"));
    vi.stubEnv("PAPERCLIP_DISABLE_CWD_ENV_FILE", "true");
    vi.stubEnv("RUN_LOG_BASE_PATH", path.join(directory, "logs"));
    for (const key of [
      "RUN_LOG_STORE",
      "PROVIDER_TRACE_STORE",
      "RUN_LOG_S3_BUCKET",
      "RUN_LOG_S3_PREFIX",
      "PROVIDER_TRACE_S3_PREFIX",
    ])
      vi.stubEnv(key, undefined);
    client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true });
    for (const bucket of buckets) await client.send(new CreateBucketCommand({ Bucket: bucket }));
    for (const bucket of buckets) {
      vi.resetModules();
      selectStack(bucket);
      const { getRunLogStore } = await import("./run-log-store.js");
      stores.push(getRunLogStore());
    }
  });
  afterAll(async () => {
    if (client) {
      for (const bucket of buckets) {
        for (;;) {
          const page = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
          if (!page.Contents?.length) break;
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: page.Contents.map((object) => ({ Key: object.Key! })) },
            }),
          );
        }
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
      client.destroy();
    }
    vi.unstubAllEnvs();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  function selectStack(bucket: string, prefix = "existing-root") {
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", bucket);
    vi.stubEnv("PAPERCLIP_STORAGE_S3_REGION", "us-east-1");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_ENDPOINT", endpoint!);
    vi.stubEnv("PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE", "true");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_PREFIX", prefix);
  }
  it("automatically uses each stack's existing bucket and prefix for identical run identities", async () => {
    const handles: Awaited<ReturnType<RunLogStore["begin"]>>[] = [];
    for (const [index, bucket] of buckets.entries()) {
      const store = stores[index]!;
      const handle = await store.begin({
        companyId: "same-company",
        agentId: "same-agent",
        runId: "same-run",
        newRun: true,
        assertWriterAuthority: async () => undefined,
      });
      handles.push(handle);
      expect(handle.store).toBe("s3_segments");
      await store.append(handle, { stream: "stdout", ts: "then", chunk: `stack-${index}`, seq: 1 });
      await store.finalize(handle);
      const keys = (await client.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents!.map(
        (object) => object.Key!,
      );
      expect(
        keys.every((key) =>
          key.startsWith("existing-root/run-logs/segments-v1/same-company/same-agent/same-run/"),
        ),
      ).toBe(true);
    }
    expect(handles[0]!.logRef).toBe(handles[1]!.logRef);
    for (const [index, store] of stores.entries()) {
      const content = (await store.read(handles[1 - index]!)).content;
      expect(content).toContain(`stack-${index}`);
      expect(content).not.toContain(`stack-${1 - index}`);
    }
    await fs.rm(path.join(directory, "logs"), { recursive: true, force: true });
    expect((await stores[0]!.read(handles[0]!)).content).toContain("stack-0");
  });
  it("honors config-file-only storage and keeps a locally configured instance local", async () => {
    for (const key of [
      "PAPERCLIP_STORAGE_PROVIDER",
      "PAPERCLIP_STORAGE_S3_BUCKET",
      "PAPERCLIP_STORAGE_S3_REGION",
      "PAPERCLIP_STORAGE_S3_ENDPOINT",
      "PAPERCLIP_STORAGE_S3_PREFIX",
      "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE",
    ])
      vi.stubEnv(key, undefined);
    await fs.writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({
        $meta: { version: 1, updatedAt: "2026-10-30T00:00:00Z", source: "configure" },
        database: { mode: "embedded-postgres" },
        logging: { mode: "file" },
        server: {},
        storage: {
          provider: "s3",
          s3: {
            bucket: buckets[0],
            region: "us-east-1",
            endpoint,
            prefix: "file-config-root",
            forcePathStyle: true,
          },
        },
      }),
    );
    vi.resetModules();
    const { getRunLogStore } = await import("./run-log-store.js");
    const external = getRunLogStore();
    const handle = await external.begin({
      companyId: "file-company",
      agentId: "agent",
      runId: "run",
      newRun: true,
      assertWriterAuthority: async () => undefined,
    });
    expect(handle.store).toBe("s3_segments");
    await external.append(handle, { stream: "stdout", ts: "then", chunk: "file-config" });
    await external.finalize(handle);
    expect(
      (
        await client.send(
          new ListObjectsV2Command({ Bucket: buckets[0], Prefix: "file-config-root/run-logs/" }),
        )
      ).KeyCount,
    ).toBeGreaterThan(0);
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.resetModules();
    const local = (await import("./run-log-store.js")).getRunLogStore();
    const localHandle = await local.begin({
      companyId: "local-company",
      agentId: "agent",
      runId: "run",
      newRun: true,
    });
    expect(localHandle.store).toBe("local_file");
    expect(() => local.read(handle)).toThrow("Object run log storage is not configured");
    await local.append(localHandle, { stream: "stdout", ts: "then", chunk: "local" });
    await local.finalize(localHandle);
    expect((await local.read(localHandle)).content).toContain("local");
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    vi.resetModules();
    const restored = (await import("./run-log-store.js")).getRunLogStore();
    expect((await restored.read(handle)).content).toContain("file-config");
    await fs.unlink(path.join(directory, "config.json"));
  });
  it("scopes trace publication and cleanup to the existing prefix, company and stack", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    const { resolveRunEvidenceStorage } = await import("./run-evidence-storage.js");
    const { createProviderTraceObjectStore } = await import("./provider-trace-object-store.js");
    const { createStorageService } = await import("../storage/service.js");
    const filename = `${randomUUID()}.ndjson`;
    const records = [];
    for (const [prefix, company] of [
      ["stack-a", "same-company"],
      ["stack-b", "same-company"],
      ["stack-a", "other-company"],
    ]) {
      selectStack(buckets[0]!, prefix);
      const config = resolveRunEvidenceStorage()!;
      const store = createProviderTraceObjectStore(config.provider, config.tracePrefix);
      const storage = createStorageService(config.provider);
      const ref = `s3-segments-v1:${company}/same-run/${filename}`;
      const file = path.join(directory, `${prefix}-${company}.ndjson`);
      const body = Buffer.from(`${JSON.stringify({ fixture: `${prefix}:${company}` })}\n`);
      await store.open(ref, file, async () => undefined);
      await fs.appendFile(file, body);
      await store.finish(ref);
      const product = await storage.putFile({
        companyId: company!,
        namespace: "attachments",
        originalFilename: "keep.txt",
        contentType: "text/plain",
        body: Buffer.from("keep"),
      });
      records.push({ store, storage, ref, body, product, company: company! });
    }
    expect(records[0]!.ref).toBe(records[1]!.ref);
    await records[0]!.store.remove(records[0]!.ref);
    await expect(records[0]!.store.read(records[0]!.ref)).rejects.toThrow("unavailable");
    for (const record of records.slice(1))
      expect(await record.store.read(record.ref)).toEqual(record.body);
    for (const record of records) {
      const object = await record.storage.getObject(record.company, record.product.objectKey);
      const chunks = [];
      for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("keep");
    }
    const keys = (
      await client.send(new ListObjectsV2Command({ Bucket: buckets[0], Prefix: "stack-b/" }))
    ).Contents!.map((object) => object.Key!);
    expect(
      keys.some((key) =>
        key.startsWith("stack-b/provider-traces/segments-v1/same-company/same-run/"),
      ),
    ).toBe(true);
    expect(keys.some((key) => key.startsWith("stack-b/same-company/attachments/"))).toBe(true);
  });
});
