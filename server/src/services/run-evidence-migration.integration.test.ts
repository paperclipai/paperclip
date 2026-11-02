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
import { formatNativeRunLogEvent } from "./native-runtime/native-run-log-export.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { createObjectByteJournal } from "./object-byte-journal.js";
import type { PrpEvent } from "../vendor/paperclip-runner/index.js";
import { compactRunLogChunk } from "./heartbeat/run-log.js";

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
    bucket = `paperclip-migration-test-${randomUUID()}`;
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
          JSON.stringify({
            ts: "then",
            seq: i + 1,
            stream: "stdout",
            chunk: `再開 ${i}`,
          }) + "\n",
      ).join(""),
    );
    const logRef = `${company}/${agent}/${run}.ndjson`;
    await fs.mkdir(path.dirname(path.join(directory, "logs", logRef)), {
      recursive: true,
    });
    await fs.writeFile(path.join(directory, "logs", logRef), log);
    await fs.mkdir(path.join(directory, "traces"), { recursive: true });
    const native = Buffer.from('{"kind":"frame","rawBase64":"e30="}\n'.repeat(33000).trimEnd()),
      rehydration = Buffer.from('{"kind":"interpretation","frameId":1}\n');
    const expectedTrace = Buffer.concat([native, Buffer.from("\n"), rehydration]);
    await fs.writeFile(path.join(directory, "traces", filename), native);
    await fs.writeFile(path.join(directory, "traces", `${filename}.rehydration`), rehydration);
    const expiry = new Date(Date.now() + 3600_000);
    await db.execute(
      sql`insert into heartbeat_runs(id, company_id, agent_id, status, log_store, log_ref, log_bytes, log_sha256, last_output_seq) values (${run}, ${company}, ${agent}, 'succeeded', 'local_file', ${logRef}, ${log.length}, ${createHash("sha256").update(log).digest("hex")}, 100)`,
    );
    await db.execute(sql`insert into provider_trace_records(id, company_id, run_id, status, provider, trace_ref, requested_by, expires_at, digest)
      values (${trace}, ${company}, ${run}, 'complete', 'codex', ${filename}, 'test', ${expiry.toISOString()}, ${`sha256:${createHash(
        "sha256",
      )
        .update(expectedTrace)
        .digest("hex")}`})`);
    const active = randomUUID(),
      missing = randomUUID(),
      corrupt = randomUUID();
    await db.execute(sql`insert into heartbeat_runs(id, company_id, agent_id, status, log_store, log_ref, log_bytes, log_sha256)
      values (${active}, ${company}, ${agent}, 'running', 'local_file', ${logRef}, ${log.length}, null),
      (${missing}, ${company}, ${agent}, 'succeeded', 'local_file', 'missing.ndjson', 10, null),
      (${corrupt}, ${company}, ${agent}, 'succeeded', 'local_file', ${logRef}, ${log.length + 1}, null)`);
    const legacyLease = randomUUID(),
      nativeLease = randomUUID(),
      leaseExpiry = new Date(Date.now() + 60_000).toISOString();
    await db.execute(sql`insert into heartbeat_runs(id, company_id, agent_id, status, log_store, log_ref, log_bytes, controller_lease_expires_at)
      values (${legacyLease}, ${company}, ${agent}, 'succeeded', 'local_file', ${logRef}, ${log.length}, ${leaseExpiry}),
      (${nativeLease}, ${company}, ${agent}, 'succeeded', 'local_file', ${logRef}, ${log.length}, null)`);
    await db.execute(
      sql`insert into native_run_finalizations values (${nativeLease}, ${company}, ${leaseExpiry})`,
    );
    const inventory = await migrateRunEvidence(db, {
      apply: false,
      companyId: company,
    });
    expect(inventory.items.find((i) => i.id === run)?.state).toBe("inventoried");
    const result = await migrateRunEvidence(db, {
      apply: true,
      companyId: company,
    });
    expect(result.items.filter((i) => i.state === "migrated")).toHaveLength(2);
    expect(result.items.filter((i) => i.state === "blocked")).toHaveLength(5);
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
        (
          await reader.read({
            store: "s3_segments",
            logRef: records[0].log_ref,
          })
        ).content,
      ),
    ).toEqual(log);
    const saved = await db.$client.unsafe(
      "select trace_ref, expires_at, status from provider_trace_records where id=$1",
      [trace],
    );
    expect(new Date(saved[0].expires_at).getTime()).toBe(expiry.getTime());
    expect(saved[0].status).toBe("complete");
    expect(await createProviderTraceObjectStore(provider).read(saved[0].trace_ref)).toEqual(
      expectedTrace,
    );
  }, 30_000);
  it("blocks a native archive with a missing committed tail and checkpoints only verified source coverage", async () => {
    const companyId = randomUUID(),
      agentId = randomUUID();
    const runs: string[] = [];
    for (const state of ["missing", "finalized", "covered"]) {
      const complete = state !== "missing",
        finalized = state === "finalized";
      const runId = randomUUID(),
        sourceInstanceId = randomUUID(),
        normalizedSessionId = randomUUID();
      runs.push(runId);
      const events: PrpEvent[] = [1, 2].map((sourceSeq) => ({
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        runId,
        sourceInstanceId,
        sourceSeq,
        sourceEventId: `${sourceInstanceId}:${sourceSeq}`,
        sourceKind: "runner",
        normalizedSessionId,
        priority: 2,
        emittedAt: "2026-10-30T00:00:00Z",
        eventType: "item.delta",
        payload: { text: `part ${sourceSeq}` },
      }));
      const logRef = `${companyId}/${agentId}/${runId}.ndjson`;
      const bytes = Buffer.from(
        events
          .slice(0, complete ? 2 : 1)
          .map(
            (event, index) =>
              JSON.stringify({
                ts: "then",
                seq: index + 1,
                stream: "stdout",
                chunk: formatNativeRunLogEvent(event),
              }) + "\n",
          )
          .join(""),
      );
      await fs.mkdir(path.dirname(path.join(directory, "logs", logRef)), { recursive: true });
      await fs.writeFile(path.join(directory, "logs", logRef), bytes);
      await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,status,runtime_mode,log_store,log_ref,log_bytes,log_sha256)
        values(${runId},${companyId},${agentId},'succeeded','native','local_file',${logRef},${finalized ? bytes.length : null},${finalized ? createHash("sha256").update(bytes).digest("hex") : null})`);
      for (const [index, event] of events.entries())
        await db.execute(sql`insert into heartbeat_run_events
        values(${companyId},${runId},${index + 1},${JSON.stringify({ prpEvent: event })}::jsonb,${sourceInstanceId},${event.sourceEventId},${event.sourceSeq},${nativeSha256(event)},${event.eventType})`);
    }
    const migrated = await migrateRunEvidence(db, { apply: true, companyId });
    expect(migrated.items.find((item) => item.id === runs[0])).toMatchObject({
      state: "blocked",
      reason: "native_log_source_coverage_unproven",
    });
    expect(migrated.items.find((item) => item.id === runs[1])?.state).toBe("migrated");
    expect(migrated.items.find((item) => item.id === runs[2])?.state).toBe("migrated");
    const provider = createS3StorageProvider({
      endpoint,
      bucket,
      region: "us-east-1",
      forcePathStyle: true,
    });
    for (const runId of runs.slice(1)) {
      const journal = createObjectByteJournal({
        provider,
        prefix: `run-logs/segments-v1/${companyId}/${agentId}/${runId}`,
      });
      expect((await journal.head())!.head.sourceCursor).toBe(2);
    }
    const [blocked] = await db.$client.unsafe("select log_store from heartbeat_runs where id=$1", [
      runs[0]!,
    ]);
    expect(blocked!.log_store).toBe("local_file");
  });
  it("migrates a digest-verified large native event while blocking unproven and corrupt files", async () => {
    const companyId = randomUUID(),
      agentId = randomUUID();
    const cases = [
      "finalized",
      "missing-size",
      "missing-digest",
      "wrong-digest",
      "wrong-size",
    ] as const;
    const runs = new Map<string, { runId: string; logRef: string; bytes: Buffer }>();
    for (const state of cases) {
      const runId = randomUUID(),
        sourceInstanceId = randomUUID();
      const event: PrpEvent = {
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        runId,
        sourceInstanceId,
        sourceSeq: 1,
        sourceEventId: `${sourceInstanceId}:1`,
        sourceKind: "runner",
        normalizedSessionId: randomUUID(),
        priority: 2,
        emittedAt: "2026-10-30T00:00:00Z",
        eventType: "item.delta",
        payload: { text: "large tool result ".repeat(12_000) },
      };
      const chunk = compactRunLogChunk(formatNativeRunLogEvent(event));
      expect(chunk).toContain("paperclip truncated run log chunk");
      expect(() => JSON.parse(chunk)).toThrow();
      const bytes = Buffer.from(
        `${JSON.stringify({ ts: "then", seq: 1, stream: "stdout", chunk })}\n`,
      );
      const logRef = `${companyId}/${agentId}/${runId}.ndjson`;
      runs.set(state, { runId, logRef, bytes });
      await fs.mkdir(path.dirname(path.join(directory, "logs", logRef)), { recursive: true });
      await fs.writeFile(path.join(directory, "logs", logRef), bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,status,runtime_mode,log_store,log_ref,log_bytes,log_sha256)
        values(${runId},${companyId},${agentId},'succeeded','native','local_file',${logRef},
        ${state === "missing-size" ? null : bytes.length + (state === "wrong-size" ? 1 : 0)},
        ${state === "missing-digest" ? null : state === "wrong-digest" ? "0".repeat(64) : digest})`);
      await db.execute(sql`insert into heartbeat_run_events values(${companyId},${runId},1,
        ${JSON.stringify({ prpEvent: event })}::jsonb,${sourceInstanceId},${event.sourceEventId},1,${nativeSha256(event)},${event.eventType})`);
    }
    const result = await migrateRunEvidence(db, { apply: true, companyId });
    const finalized = runs.get("finalized")!;
    expect(result.items.find((item) => item.id === finalized.runId)?.state).toBe("migrated");
    for (const state of cases.slice(1)) {
      const run = runs.get(state)!;
      expect(result.items.find((item) => item.id === run.runId)).toMatchObject({
        state: "blocked",
        reason: state.startsWith("wrong-")
          ? "legacy_length_or_digest_mismatch"
          : "native_log_source_coverage_unproven",
      });
      const [row] = await db.$client.unsafe("select log_store from heartbeat_runs where id=$1", [
        run.runId,
      ]);
      expect(row!.log_store).toBe("local_file");
    }
    const provider = createS3StorageProvider({
      endpoint,
      bucket,
      region: "us-east-1",
      forcePathStyle: true,
    });
    const logRef = `${companyId}/${agentId}/${finalized.runId}`;
    const journal = createObjectByteJournal({ provider, prefix: `run-logs/segments-v1/${logRef}` });
    expect((await journal.head())!.head.sourceCursor).toBe(1);
    await fs.unlink(path.join(directory, "logs", finalized.logRef));
    const reader = createObjectRunLogStore({
      provider,
      keyPrefix: "run-logs",
      assertWriterAuthority: async () => {
        throw new Error("read-only");
      },
    });
    expect(Buffer.from((await reader.read({ store: "s3_segments", logRef })).content)).toEqual(
      finalized.bytes,
    );
  });
});
