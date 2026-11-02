import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { createDb, providerTraceRecords, type Db } from "@paperclipai/db";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { providerTraceStore } from "./provider-trace-store.js";
import { idleWorkSnapshot } from "./task-admission.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";

vi.mock("./activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));
const databaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RUN_EVIDENCE_MIGRATION_DATABASE_URL");
const endpoint = process.env.PAPERCLIP_LOG_TEST_S3_ENDPOINT;
describe.skipIf(!databaseUrl)("provider trace retention and capture ownership", () => {
  let db: Db, directory: string, client: S3Client | undefined;
  const schema = `trace_retention_${randomUUID().replaceAll("-", "")}`;
  const bucket = `pc-trace-retention-${randomUUID()}`;
  let bucketCreated = false;
  const owners: Array<{
    store: ReturnType<typeof providerTraceStore>;
    run: string;
    company: string;
  }> = [];
  beforeAll(async () => {
    db = createDb(databaseUrl!, { maxConnections: 1 });
    await db.execute(sql.raw(`create schema ${schema}`));
    await db.execute(sql.raw(`set search_path=${schema}`));
    await db.execute(sql`create table provider_trace_records(id uuid primary key default gen_random_uuid(), company_id uuid not null, run_id uuid not null unique,
      status text not null, provider text not null, trace_ref text not null, frame_count int not null default 0,
      byte_count bigint not null default 0, digest text, reason text, requested_by text not null, expires_at timestamptz not null,
      deleted_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
    if (endpoint) {
      client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true });
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      bucketCreated = true;
    }
  });
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "trace-retention-"));
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(directory, "config.json"));
    vi.stubEnv("PROVIDER_TRACE_BASE_PATH", directory);
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "e".repeat(64));
    await db.execute(sql`truncate provider_trace_records`);
  });
  afterEach(async () => {
    for (const { store, run, company } of owners.splice(0))
      await store.finalize(run, company).catch(() => undefined);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    if (client && bucketCreated) {
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
      client.destroy();
    }
    if (db) {
      await db.execute(sql.raw(`drop schema ${schema} cascade`));
      await db.$client.end();
    }
  });
  function external() {
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", bucket);
    vi.stubEnv("PAPERCLIP_STORAGE_S3_ENDPOINT", endpoint!);
    vi.stubEnv("PAPERCLIP_STORAGE_S3_REGION", "us-east-1");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE", "true");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_PREFIX", "");
  }
  it("schedules expiry when a new local trace is created after startup becomes quiet", async () => {
    const store = providerTraceStore(db),
      companyId = randomUUID(),
      runId = randomUUID();
    expect(await store.nextRetentionDeadline()).toBeNull();
    const capture = await store.prepare({
      companyId,
      runId,
      provider: "codex",
      requestedBy: "test",
    });
    expect(await store.nextRetentionDeadline()).toBe(
      new Date(capture.metadata.expiresAt).getTime(),
    );
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", bucket);
    vi.stubEnv("PAPERCLIP_STORAGE_S3_ENDPOINT", "http://127.0.0.1:1");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", undefined);
    const replacement = providerTraceStore(db);
    expect(await replacement.getByRun(runId, companyId)).not.toBeNull();
    await replacement.remove(runId, companyId);
    expect(await store.nextRetentionDeadline()).toBeNull();
  });
  it("drains more than one page of expired local files without requiring another producer", async () => {
    const companyId = randomUUID(),
      expiresAt = new Date(Date.now() - 60_000);
    const rows = Array.from({ length: 201 }, () => ({
      companyId,
      runId: randomUUID(),
      status: "complete",
      provider: "codex",
      traceRef: `${randomUUID()}.ndjson`,
      requestedBy: "test",
      expiresAt,
    }));
    for (const row of rows) await fs.writeFile(path.join(directory, row.traceRef), "{}\n");
    await db.insert(providerTraceRecords).values(rows);
    const store = providerTraceStore(db);
    expect(await store.nextRetentionDeadline()).toBeLessThanOrEqual(Date.now());
    expect(await store.cleanupExpired()).toHaveLength(100);
    expect(await store.nextRetentionDeadline()).not.toBeNull();
    expect(await store.cleanupExpired()).toHaveLength(100);
    expect(await store.nextRetentionDeadline()).not.toBeNull();
    expect(await store.cleanupExpired()).toHaveLength(1);
    expect(await store.nextRetentionDeadline()).toBeNull();
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it("retains an expired local cleanup deadline after filesystem deletion fails", async () => {
    const companyId = randomUUID(),
      runId = randomUUID(),
      traceRef = `${randomUUID()}.ndjson`;
    const file = path.join(directory, traceRef);
    await fs.mkdir(file);
    await db
      .insert(providerTraceRecords)
      .values({
        companyId,
        runId,
        traceRef,
        status: "complete",
        provider: "codex",
        requestedBy: "test",
        expiresAt: new Date(Date.now() - 60_000),
      });
    const store = providerTraceStore(db);
    await expect(store.cleanupExpired()).rejects.toThrow();
    expect(await store.nextRetentionDeadline()).toBeLessThanOrEqual(Date.now());
    await fs.rmdir(file);
    await fs.writeFile(file, "{}\n");
    await store.cleanupExpired();
    expect(await store.nextRetentionDeadline()).toBeNull();
  });
  it.skipIf(!endpoint)(
    "shares capture ownership across routes and workers and releases deleted captures",
    async () => {
      external();
      const company = randomUUID(),
        run = randomUUID(),
        baseline = idleWorkSnapshot().active;
      const heartbeat = providerTraceStore(db),
        route = providerTraceStore(db);
      owners.push({ store: heartbeat, run, company });
      await heartbeat.prepare({
        companyId: company,
        runId: run,
        provider: "codex",
        requestedBy: "test",
        assertWriterAuthority: async () => undefined,
      });
      expect(idleWorkSnapshot().active).toBe(baseline + 1);
      const other = randomUUID();
      await db.insert(providerTraceRecords).values({
        companyId: company,
        runId: other,
        status: "complete",
        provider: "codex",
        traceRef: `s3-segments-v1:${company}/${other}/${randomUUID()}.ndjson`,
        requestedBy: "test",
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await expect(route.remove(run, company)).rejects.toThrow("cleanup_pending");
      expect(await route.nextRetentionDeadline()).toBeLessThanOrEqual(Date.now());
      await route.remove(other, company);
      expect(idleWorkSnapshot().active).toBe(baseline);
      expect(await heartbeat.finalize(run, company)).toBeNull();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 31_000);
      await route.remove(run, company);
      expect(await route.nextRetentionDeadline()).toBeNull();
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );
  it.skipIf(!endpoint)(
    "keeps an interrupted import readable locally and fences its staged remote prefix on deletion",
    async () => {
      external();
      const companyId = randomUUID(),
        runId = randomUUID(),
        filename = `${randomUUID()}.ndjson`;
      const traceRef = `s3-import-v1:${companyId}/${runId}/${filename}`;
      const bytes = Buffer.from('{"kind":"frame","rawBase64":"e30="}\n');
      await fs.writeFile(path.join(directory, filename), bytes);
      await db.insert(providerTraceRecords).values({
        companyId,
        runId,
        traceRef,
        status: "complete",
        provider: "codex",
        requestedBy: "test",
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const store = providerTraceStore(db);
      expect((await store.download(runId, companyId))!.bytes).toEqual(bytes);
      await store.remove(runId, companyId);
      expect(await store.download(runId, companyId)).toBeNull();
      expect(await store.nextRetentionDeadline()).toBeNull();
      expect(await fs.readdir(directory)).toEqual([]);
      const objects = await client!.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `provider-traces/segments-v1/${companyId}/${runId}/${filename}/`,
        }),
      );
      expect(objects.Contents).toHaveLength(2);
      expect(objects.Contents!.every((object) => object.Key!.endsWith("head.json"))).toBe(true);
    },
  );
  it.skipIf(!endpoint)(
    "does not resurrect a trace deleted before its first journal claim",
    async () => {
      external();
      const company = randomUUID(),
        run = randomUUID(),
        baseline = idleWorkSnapshot().active;
      const heartbeat = providerTraceStore(db),
        route = providerTraceStore(db);
      owners.push({ store: heartbeat, run, company });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const preparing = heartbeat.prepare({
        companyId: company,
        runId: run,
        provider: "codex",
        requestedBy: "test",
        assertWriterAuthority: async () => {
          enter();
          await blocked;
        },
      });
      await entered;
      await route.remove(run, company);
      release();
      await expect(preparing).rejects.toThrow();
      expect(idleWorkSnapshot().active).toBe(baseline);
      expect(await heartbeat.finalize(run, company)).toBeNull();
      expect(await route.download(run, company)).toBeNull();
      const objects = await client!.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `provider-traces/segments-v1/${company}/${run}/`,
        }),
      );
      expect(objects.Contents).toHaveLength(2);
      for (const object of objects.Contents!) expect(object.Key).toMatch(/head\.json$/);
    },
  );
});
