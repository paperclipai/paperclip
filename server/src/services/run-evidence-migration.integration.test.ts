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
import { getRunLogStore, openLegacyRunLogForMigration } from "./run-log-store.js";
import { readRecoverableRunLog } from "./native-runtime/native-run-log-recovery.js";

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
  it("archives incomplete native history only offline, reads it without the old disk, and never repairs or reopens it", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    const provider = createS3StorageProvider({ endpoint, bucket, region: "us-east-1", forcePathStyle: true });
    const cases = ["old-format", "interrupted", "corrupt-source", "wrong-digest", "active-lease", "active-finalizer", "mirror"] as const;
    const runs = new Map<string, { id: string; ref: string; bytes: Buffer }>();
    for (const name of cases) {
      const id = randomUUID(), ref = `${companyId}/${agentId}/${id}.ndjson`;
      // Retain the original old formatter bytes, including its partial last line.
      const bytes = Buffer.from('{"seq":1,"stream":"stdout","chunk":"surviving 再開 output"}\n{"partial":');
      runs.set(name, { id, ref, bytes });
      await fs.mkdir(path.dirname(path.join(directory, "logs", ref)), { recursive: true });
      if (name === "mirror") await provider.putObject({ objectKey: `run-logs/${ref}`, body: bytes,
        contentType: "application/x-ndjson", contentLength: bytes.length });
      else await fs.writeFile(path.join(directory, "logs", ref), bytes);
      await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,status,runtime_mode,log_store,log_ref,log_sha256,controller_lease_expires_at)
        values(${id},${companyId},${agentId},${name === "interrupted" ? "interrupted" : "failed"},'native','local_file',${ref},
          ${name === "wrong-digest" ? "0".repeat(64) : null},${name === "active-lease" ? new Date(Date.now()+60_000).toISOString() : null})`);
      if (name === "corrupt-source") await db.execute(sql`insert into heartbeat_run_events
        values(${companyId},${id},1,'{}'::jsonb,'old-source','old-event',1,'bad-digest','item.delta')`);
      if (name === "active-finalizer") await db.execute(sql`insert into native_run_finalizations
        values(${id},${companyId},${new Date(Date.now()+60_000).toISOString()})`);
    }
    const snapshot = await db.$client.unsafe("select * from heartbeat_run_events where company_id=$1", [companyId]);
    vi.stubEnv("RUN_LOG_S3_BUCKET", bucket);
    vi.stubEnv("RUN_LOG_S3_ENDPOINT", endpoint!);
    vi.stubEnv("RUN_LOG_S3_REGION", "us-east-1");
    vi.stubEnv("RUN_LOG_S3_FORCE_PATH_STYLE", "true");
    vi.stubEnv("RUN_LOG_S3_PREFIX", "run-logs");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "false");
    const options = { apply: true, companyId, kinds: ["log"] as const, preserveHistoricalFiles: true };
    await expect(migrateRunEvidence(db, options)).rejects.toThrow("historical_log_archive_requires_offline_migration");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const active = randomUUID();
    // A different company's active execution must also block offline archival.
    await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,status) values(${active},${randomUUID()},${randomUUID()},'running')`);
    await expect(migrateRunEvidence(db, options)).rejects.toThrow("active_execution_requires_drain");
    await db.execute(sql`delete from heartbeat_runs where id=${active}`);
    const result = await migrateRunEvidence(db, options);
    const store = getRunLogStore();
    for (const name of cases.slice(0, 3)) {
      const run = runs.get(name)!;
      expect(result.items.find(item => item.id === run.id)).toMatchObject({
        state: "migrated", historicalArchive: true, bytes: run.bytes.length,
        sha256: createHash("sha256").update(run.bytes).digest("hex"),
      });
      const [row] = await db.$client.unsafe("select status,log_store,log_ref,log_bytes,log_sha256 from heartbeat_runs where id=$1", [run.id]);
      expect(row).toMatchObject({ status: name === "interrupted" ? "interrupted" : "failed",
        log_store: "s3_archive", log_ref: `${companyId}/${agentId}/${run.id}.archive`, log_bytes: null, log_sha256: null });
      await fs.rm(path.join(directory, "logs", run.ref));
      const handle = { store: "s3_archive" as const, logRef: row!.log_ref as string };
      expect((await readRecoverableRunLog(db, store, handle)).content).toBe(run.bytes.toString("utf8"));
      expect(() => store.begin({ companyId, agentId, runId: run.id, previousStore: "s3_archive" })).toThrow("read-only");
      const event = { ts: "now", stream: "stdout" as const, chunk: "must not append" };
      expect(() => store.append(handle, event)).toThrow("read-only");
      expect(() => store.enqueue!(handle, event)).toThrow("read-only");
      expect(() => store.finalize(handle)).toThrow("read-only");
      await expect(store.flush!(handle)).rejects.toThrow("read-only");
      const journal = createObjectByteJournal({ provider, prefix: `run-logs/segments-v1/${handle.logRef}` });
      expect((await journal.head())!.head.sourceCursor).toBe(0);
      expect((await store.read(handle)).content).toBe(run.bytes.toString("utf8"));
    }
    expect(await db.$client.unsafe("select * from heartbeat_run_events where company_id=$1", [companyId])).toEqual(snapshot);
    for (const [name, reason] of [["wrong-digest", "legacy_length_or_digest_mismatch"],
      ["active-lease", "legacy_writer_not_drained"], ["active-finalizer", "legacy_writer_not_drained"],
      ["mirror", "mirror_completeness_unproven"]]) {
      expect(result.items.find(item => item.id === runs.get(name!)!.id)).toMatchObject({ state: "blocked", reason });
    }
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "false");
    // A source that changes after it was opened cannot be published as a stable archive.
    const sourceRun = runs.get("wrong-digest")!;
    const source = await openLegacyRunLogForMigration(sourceRun.ref);
    for await (const _ of source.stream) { /* consume the real file */ }
    await fs.appendFile(path.join(directory, "logs", sourceRun.ref), "changed");
    if (source.source !== "local") throw new Error("expected real local source");
    await expect(source.assertUnchanged()).rejects.toThrow("legacy_log_source_changed");
  });
  it("fails the offline page if new execution appears during publication, and resumes verified history", async () => {
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), activeId = randomUUID();
    const logRef = `${companyId}/${agentId}/${runId}.ndjson`, bytes = "old unfinished history";
    await fs.mkdir(path.dirname(path.join(directory, "logs", logRef)), { recursive: true });
    await fs.writeFile(path.join(directory, "logs", logRef), bytes);
    await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,status,runtime_mode,log_store,log_ref)
      values(${runId},${companyId},${agentId},'failed','native','local_file',${logRef})`);
    // Fault injection at the real PostgreSQL publication boundary. The old
    // run is still terminal; a new run violates the global offline contract.
    await db.$client.unsafe(`create function admit_during_publication() returns trigger language plpgsql as $$
      begin if new.id='${runId}' then insert into heartbeat_runs(id,company_id,agent_id,status)
        values('${activeId}','${companyId}','${agentId}','running'); end if; return new; end $$;
      create trigger admit_during_publication before update on heartbeat_runs
        for each row execute function admit_during_publication()`);
    const options = { apply: true, companyId, kinds: ["log"] as const, preserveHistoricalFiles: true };
    try {
      await expect(migrateRunEvidence(db, options)).rejects.toThrow("active_execution_requires_drain");
      const [row] = await db.$client.unsafe("select status,log_store,log_bytes from heartbeat_runs where id=$1", [runId]);
      expect(row).toMatchObject({ status: "failed", log_store: "s3_archive", log_bytes: null });
    } finally {
      await db.$client.unsafe("drop trigger admit_during_publication on heartbeat_runs; drop function admit_during_publication()");
      await db.execute(sql`delete from heartbeat_runs where id=${activeId}`);
    }
    expect((await migrateRunEvidence(db, options)).items).toEqual([]);
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "false");
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
      "different-source",
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
        ${state === "missing-size" || state === "different-source" ? null : bytes.length + (state === "wrong-size" ? 1 : 0)},
        ${state === "missing-digest" ? null : state === "wrong-digest" ? "0".repeat(64) : digest})`);
      // A similar truncated display string cannot prove a different canonical event.
      if (state === "different-source") event.payload = { text: "different source ".repeat(12_000) };
      await db.execute(sql`insert into heartbeat_run_events values(${companyId},${runId},1,
        ${JSON.stringify({ prpEvent: event })}::jsonb,${sourceInstanceId},${event.sourceEventId},1,${nativeSha256(event)},${event.eventType})`);
    }
    const result = await migrateRunEvidence(db, { apply: true, companyId });
    const finalized = runs.get("finalized")!;
    for (const state of cases.slice(0, 3)) {
      expect(result.items.find((item) => item.id === runs.get(state)!.runId)?.state).toBe("migrated");
    }
    for (const state of cases.slice(3)) {
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
