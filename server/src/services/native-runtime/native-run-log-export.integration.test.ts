import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createS3StorageProvider } from "../../storage/s3-provider.js";
import { createObjectRunLogStore } from "../object-run-log-store.js";
import { createNativeRunLogExporter, formatNativeRunLogEvent } from "./native-run-log-export.js";
import { recoverSettledNativeRunLog } from "./native-run-log-recovery.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { createNativeRunLogTestTables } from "../../__tests__/helpers/native-run-log-database.js";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";

const url = resolveExternalTestDatabaseUrl("PAPERCLIP_RUN_EVIDENCE_MIGRATION_DATABASE_URL");
const endpoint = process.env.PAPERCLIP_LOG_TEST_S3_ENDPOINT;
describe.skipIf(!url || !endpoint)("native run log source recovery", () => {
  const schema = `native_log_${randomUUID().replaceAll("-", "")}`,
    bucket = `pc-native-log-${randomUUID()}`;
  let db: Db,
    client: S3Client,
    bucketCreated = false;
  beforeAll(async () => {
    db = createDb(url!, { maxConnections: 1, idleTimeoutSeconds: 0 });
    await db.execute(sql.raw(`create schema ${schema}`));
    await db.execute(sql.raw(`set search_path=${schema}`));
    await createNativeRunLogTestTables(db);
    client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
  });
  afterAll(async () => {
    if (client && bucketCreated) {
      for (;;) {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        if (!page.Contents?.length) break;
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: page.Contents.map((item) => ({ Key: item.Key! })) },
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
  async function fixture() {
    const binding = {
      companyId: randomUUID(),
      runId: randomUUID(),
      agentId: randomUUID(),
      sessionId: randomUUID(),
      issueId: randomUUID(),
      sourceInstanceId: randomUUID(),
      controlPlaneSourceInstanceId: randomUUID(),
      completionContractId: randomUUID(),
      completionContractSha256: "test",
    };
    await db.execute(
      sql`insert into heartbeat_runs(id,company_id,agent_id,status) values(${binding.runId},${binding.companyId},${binding.agentId},'running')`,
    );
    const provider = createS3StorageProvider({
      endpoint,
      bucket,
      region: "us-east-1",
      forcePathStyle: true,
    });
    const store = () =>
      createObjectRunLogStore({
        provider,
        keyPrefix: "logs",
        flushMs: 30_000,
        assertWriterAuthority: async (input) => {
          await input.assertWriterAuthority?.();
        },
      });
    const begin = { companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId };
    const port = new PaperclipControlPlanePort(db, binding);
    const event = (seq: number): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      schemaVersion: 1,
      sourceInstanceId: binding.sourceInstanceId,
      sourceEventId: `${binding.sourceInstanceId}:${seq}`,
      sourceSeq: seq,
      sourceKind: "runner",
      runId: binding.runId,
      normalizedSessionId: binding.sessionId,
      eventType: "item.delta",
      priority: 2,
      emittedAt: new Date().toISOString(),
      payload: { text: `step ${seq} 再開` },
    });
    return { binding, store, begin, port, event };
  }
  it("replays acknowledged native records into a new writer, repairs gaps, and ignores late duplicates", async () => {
    const f = await fixture(),
      a = f.store(),
      h = await a.begin(f.begin);
    await db.execute(
      sql`update heartbeat_runs set log_store='s3_segments', log_ref=${h.logRef} where id=${f.binding.runId}`,
    );
    const events = [f.event(1), f.event(2), f.event(3)];
    const cursors = await Promise.all(events.slice(0, 2).map((event) => f.port.appendEvent(event)));
    const receipt = await a.enqueue!(h, {
      stream: "stdout",
      chunk: formatNativeRunLogEvent(events[0]!),
      ts: "then",
      seq: 1,
      sourceCursor: cursors[0]!.cursor,
    });
    await a.flush!(h);
    await receipt.committed;
    const b = f.store(),
      successor = await b.begin(f.begin);
    let seq = successor.initialSequence!;
    const exporter = createNativeRunLogExporter({
      db,
      companyId: f.binding.companyId,
      runId: f.binding.runId,
      afterCursor: successor.initialSourceCursor!,
      enqueue: async (sourceCursor, chunk) => {
        const queued = await b.enqueue!(successor, {
          stream: "stdout",
          chunk,
          ts: "now",
          seq: ++seq,
          sourceCursor,
        });
        void queued.committed.catch(() => undefined);
      },
      flush: () => b.flush!(successor),
    });
    const third = await f.port.appendEvent(events[2]!);
    await exporter.record(third.cursor, formatNativeRunLogEvent(events[2]!));
    await exporter.record(cursors[0]!.cursor, formatNativeRunLogEvent(events[0]!));
    await b.finalize(successor);
    const entries = (await b.read(successor)).content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(JSON.parse(line).chunk).event);
    expect(entries.map((event) => event.sourceSeq)).toEqual([1, 2, 3]);
    expect(
      await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, f.binding.runId)),
    ).toHaveLength(3);
  });
  it("repairs a settled run on demand after its controller lease expires, without extending source retention", async () => {
    const f = await fixture(),
      a = f.store(),
      h = await a.begin(f.begin);
    await f.port.appendEvent(f.event(1));
    await db.execute(
      sql`update heartbeat_runs set status='succeeded', log_store='s3_segments', log_ref=${h.logRef} where id=${f.binding.runId}`,
    );
    await db.execute(
      sql`insert into native_run_finalizations values(${f.binding.runId},${f.binding.companyId},now()+interval '1 minute')`,
    );
    const b = f.store();
    await recoverSettledNativeRunLog(db, b, h.logRef, async () => ({ enabled: false }));
    expect((await b.read(h)).content).toBe("");
    await db.execute(
      sql`update native_run_finalizations set lease_expires_at=now()-interval '1 second' where run_id=${f.binding.runId}`,
    );
    await Promise.all(
      [1, 2].map(() =>
        recoverSettledNativeRunLog(db, b, h.logRef, async () => ({ enabled: false })),
      ),
    );
    expect((await b.read(h)).content.trim().split("\n")).toHaveLength(1);
    const [run] = await db
      .select({ bytes: heartbeatRuns.logBytes })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.binding.runId));
    expect(run!.bytes).toBeGreaterThan(0);
  });
  it("rejects a corrupt canonical source without marking the partial archive complete", async () => {
    const f = await fixture(),
      a = f.store(),
      h = await a.begin(f.begin);
    await f.port.appendEvent(f.event(1));
    await db.execute(
      sql`update heartbeat_run_events set source_payload_sha256='wrong' where run_id=${f.binding.runId}`,
    );
    await db.execute(
      sql`update heartbeat_runs set status='succeeded', log_store='s3_segments', log_ref=${h.logRef} where id=${f.binding.runId}`,
    );
    await expect(
      recoverSettledNativeRunLog(db, f.store(), h.logRef, async () => ({ enabled: false })),
    ).rejects.toThrow("integrity");
    const [run] = await db
      .select({ bytes: heartbeatRuns.logBytes })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.binding.runId));
    expect(run!.bytes).toBeNull();
  });
});
