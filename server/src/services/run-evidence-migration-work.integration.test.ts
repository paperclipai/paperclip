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
import { registerRunEvidenceMigrationWork } from "./run-evidence-migration-work.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { createObjectRunLogStore } from "./object-run-log-store.js";
import { createProviderTraceObjectStore } from "./provider-trace-object-store.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";

const endpoint = process.env.PAPERCLIP_LOG_TEST_S3_ENDPOINT;
const databaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RUN_EVIDENCE_MIGRATION_DATABASE_URL");
describe.skipIf(!endpoint || !databaseUrl)(
  "automatic retained history upgrade (Postgres and S3)",
  () => {
    let db: Db, client: S3Client, bucket: string, directory: string;
    const schema = `automatic_migration_${randomUUID().replaceAll("-", "")}`;
    beforeAll(async () => {
      db = createDb(databaseUrl!, { maxConnections: 1 });
      await db.execute(sql.raw(`create schema ${schema}`));
      await db.execute(sql.raw(`set search_path=${schema}`));
      await db.execute(sql`create table heartbeat_runs (id uuid primary key, company_id uuid not null, agent_id uuid not null,
      status text not null, runtime_mode text default 'legacy', log_store text, log_ref text, log_bytes bigint, log_sha256 text, last_output_seq int not null default 0, controller_lease_expires_at timestamptz)`);
      await db.execute(
        sql`create table native_run_finalizations(run_id uuid, company_id uuid, lease_expires_at timestamptz)`,
      );
      await db.execute(sql`create table heartbeat_run_events(company_id uuid,run_id uuid,seq bigint,payload jsonb,
      source_instance_id text,source_event_id text,source_seq bigint,source_payload_sha256 text,event_type text)`);
      await db.execute(sql`create table provider_trace_records (id uuid primary key, company_id uuid not null, run_id uuid not null,
      status text not null, provider text not null, trace_ref text not null, frame_count int not null default 0,
      byte_count bigint not null default 0, digest text, reason text, requested_by text not null, expires_at timestamptz not null,
      deleted_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-migration-"));
      vi.stubEnv("PAPERCLIP_CONFIG", path.join(directory, "config.json"));
      vi.stubEnv("RUN_LOG_BASE_PATH", path.join(directory, "logs"));
      vi.stubEnv("PROVIDER_TRACE_BASE_PATH", path.join(directory, "traces"));
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "b".repeat(64));
      vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
      vi.stubEnv("PAPERCLIP_STORAGE_S3_ENDPOINT", endpoint!);
      vi.stubEnv("PAPERCLIP_STORAGE_S3_REGION", "us-east-1");
      vi.stubEnv("PAPERCLIP_STORAGE_S3_PREFIX", "");
      vi.stubEnv("PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE", "true");
      bucket = `pc-auto-migration-${randomUUID()}`;
      vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", bucket);
      client = new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
      });
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
    it("copies retained logs and a trace automatically, then reads them without their source directories", async () => {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        runId = randomUUID(),
        traceId = randomUUID();
      const logRef = `${companyId}/${agentId}/${runId}.ndjson`;
      const filename = `${randomUUID()}.ndjson`;
      const log = Buffer.from('{"stream":"stdout","chunk":"retained 再開","seq":1}\n');
      const trace = Buffer.from('{"kind":"frame","rawBase64":"e30="}\n');
      await fs.mkdir(path.dirname(path.join(directory, "logs", logRef)), { recursive: true });
      await fs.writeFile(path.join(directory, "logs", logRef), log);
      await fs.mkdir(path.join(directory, "traces"), { recursive: true });
      await fs.writeFile(path.join(directory, "traces", filename), trace);
      const expiry = new Date(Date.now() + 3600_000).toISOString();
      await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,status,log_store,log_ref,log_bytes,log_sha256)
      values(${runId},${companyId},${agentId},'succeeded','local_file',${logRef},${log.length},${createHash("sha256").update(log).digest("hex")})`);
      await db.execute(sql`insert into provider_trace_records(id,company_id,run_id,status,provider,trace_ref,requested_by,expires_at,digest)
      values(${traceId},${companyId},${runId},'complete','codex',${filename},'test',${expiry},${`sha256:${createHash("sha256").update(trace).digest("hex")}`})`);
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      const worker = registerRunEvidenceMigrationWork(db, coordinator, () => true)!;
      try {
        await worker.ready;
        await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 5_000 });
        expect(onError).not.toHaveBeenCalled();
        await fs.rm(path.join(directory, "logs"), { recursive: true });
        await fs.rm(path.join(directory, "traces"), { recursive: true });
        const [run] = await db.$client.unsafe(
          "select log_store,log_ref from heartbeat_runs where id=$1",
          [runId],
        );
        const [saved] = await db.$client.unsafe(
          "select trace_ref,expires_at from provider_trace_records where id=$1",
          [traceId],
        );
        expect(run!.log_store).toBe("s3_segments");
        expect(new Date(saved!.expires_at).toISOString()).toBe(expiry);
        const provider = createS3StorageProvider({
          endpoint,
          bucket,
          region: "us-east-1",
          forcePathStyle: true,
        });
        const logs = createObjectRunLogStore({
          provider,
          keyPrefix: "run-logs",
          assertWriterAuthority: async () => {
            throw Error("read-only");
          },
        });
        expect(
          Buffer.from((await logs.read({ store: run!.log_store, logRef: run!.log_ref })).content),
        ).toEqual(log);
        expect(await createProviderTraceObjectStore(provider).read(saved!.trace_ref)).toEqual(
          trace,
        );
      } finally {
        await worker.stop();
        await coordinator.stop();
      }
    });
  },
);
