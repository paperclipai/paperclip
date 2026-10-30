import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";
import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateRunEvidence } from "./run-evidence-migration.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createObjectRunLogStore } from "./object-run-log-store.js";
import { createProviderTraceObjectStore } from "./provider-trace-object-store.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";

const endpoint = process.env.PAPERCLIP_LOG_TEST_S3_ENDPOINT;
const databaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RUN_EVIDENCE_MIGRATION_DATABASE_URL");
describe.skipIf(!endpoint || !databaseUrl)("run evidence migration (Postgres and S3)", () => {
  let db: Db, client: S3Client, bucket: string, directory: string;
  const schema = `migration_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    db = createDb(databaseUrl!, { maxConnections: 1 });
    await db.execute(sql.raw(`create schema ${schema}`));
    await db.execute(sql.raw(`set search_path=${schema}`));
    await db.execute(sql`create table heartbeat_runs (id uuid primary key, company_id uuid not null, agent_id uuid not null,
      status text not null, log_store text, log_ref text, log_bytes bigint, log_sha256 text, last_output_seq int not null default 0)`);
    await db.execute(sql`create table provider_trace_records (id uuid primary key, company_id uuid not null, run_id uuid not null,
      status text not null, provider text not null, trace_ref text not null, frame_count int not null default 0,
      byte_count bigint not null default 0, digest text, reason text, requested_by text not null, expires_at timestamptz not null,
      deleted_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-migration-"));
    vi.stubEnv("RUN_LOG_BASE_PATH", path.join(directory, "logs"));
    vi.stubEnv("PROVIDER_TRACE_BASE_PATH", path.join(directory, "traces"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "b".repeat(64));
    vi.stubEnv("RUN_LOG_S3_ENDPOINT", endpoint!);
    vi.stubEnv("RUN_LOG_S3_REGION", "us-east-1");
    bucket = `paperclip-migration-test-${randomUUID()}`;
    vi.stubEnv("RUN_LOG_S3_BUCKET", bucket);
    client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }, 30_000);
  afterAll(async () => {
    if (client) {
      for (;;) {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        if (!page.Contents?.length) break;
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: page.Contents.map((o) => ({ Key: o.Key! })) },
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
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it("preserves exact historical bytes and expiry, while refusing active/missing/corrupt sources", async () => {
    const company = randomUUID(),
      agent = randomUUID(),
      run = randomUUID(),
      trace = randomUUID(),
      filename = `${randomUUID()}.ndjson`;
    const log = Buffer.from(
      Array.from(
        { length: 100 },
        (_, i) =>
          JSON.stringify({ ts: "then", seq: i + 1, stream: "stdout", chunk: `再開 ${i}` }) + "\n",
      ).join(""),
    );
    const logRef = `${company}/${agent}/${run}.ndjson`;
    await fs.mkdir(path.dirname(path.join(directory, "logs", logRef)), { recursive: true });
    await fs.writeFile(path.join(directory, "logs", logRef), log);
    await fs.mkdir(path.join(directory, "traces"), { recursive: true });
    const native = Buffer.from('{"kind":"frame","rawBase64":"e30="}\n'),
      rehydration = Buffer.from('{"kind":"interpretation","frameId":1}\n');
    await fs.writeFile(path.join(directory, "traces", filename), native);
    await fs.writeFile(path.join(directory, "traces", `${filename}.rehydration`), rehydration);
    const expiry = new Date(Date.now() + 3600_000);
    await db.execute(
      sql`insert into heartbeat_runs values (${run}, ${company}, ${agent}, 'succeeded', 'local_file', ${logRef}, ${log.length}, ${createHash("sha256").update(log).digest("hex")}, 100)`,
    );
    await db.execute(sql`insert into provider_trace_records(id, company_id, run_id, status, provider, trace_ref, requested_by, expires_at, digest)
      values (${trace}, ${company}, ${run}, 'complete', 'codex', ${filename}, 'test', ${expiry.toISOString()}, ${`sha256:${createHash(
        "sha256",
      )
        .update(Buffer.concat([native, rehydration]))
        .digest("hex")}`})`);
    const active = randomUUID(),
      missing = randomUUID(),
      corrupt = randomUUID();
    await db.execute(sql`insert into heartbeat_runs(id, company_id, agent_id, status, log_store, log_ref, log_bytes, log_sha256)
      values (${active}, ${company}, ${agent}, 'running', 'local_file', ${logRef}, ${log.length}, null),
      (${missing}, ${company}, ${agent}, 'succeeded', 'local_file', 'missing.ndjson', 10, null),
      (${corrupt}, ${company}, ${agent}, 'succeeded', 'local_file', ${logRef}, ${log.length + 1}, null)`);
    const inventory = await migrateRunEvidence(db, { apply: false, companyId: company });
    expect(inventory.items.find((i) => i.id === run)?.state).toBe("inventoried");
    const result = await migrateRunEvidence(db, { apply: true, companyId: company });
    expect(result.items.filter((i) => i.state === "migrated")).toHaveLength(2);
    expect(result.items.filter((i) => i.state === "blocked")).toHaveLength(3);
    const records = await db.$client.unsafe(
      "select log_store, log_ref from heartbeat_runs where id=$1",
      [run],
    );
    expect(records[0].log_store).toBe("s3_segments");
    const provider = createS3StorageProvider({
      endpoint,
      bucket,
      region: "us-east-1",
      forcePathStyle: true,
    });
    const reader = createObjectRunLogStore({
      provider,
      keyPrefix: "run-logs",
      assertWriterAuthority: async () => {
        throw Error("read-only");
      },
    });
    await fs.rm(path.join(directory, "logs"), { recursive: true });
    await fs.rm(path.join(directory, "traces"), { recursive: true });
    expect(
      Buffer.from(
        (await reader.read({ store: "s3_segments", logRef: records[0].log_ref })).content,
      ),
    ).toEqual(log);
    const saved = await db.$client.unsafe(
      "select trace_ref, expires_at, status from provider_trace_records where id=$1",
      [trace],
    );
    expect(new Date(saved[0].expires_at).getTime()).toBe(expiry.getTime());
    expect(saved[0].status).toBe("complete");
    expect(await createProviderTraceObjectStore(provider).read(saved[0].trace_ref)).toEqual(
      Buffer.concat([native, rehydration]),
    );
  }, 30_000);
});
