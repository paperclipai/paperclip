import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import { closeRegisteredClients, createDb, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { createNativeRunLogTestTables } from "../../__tests__/helpers/native-run-log-database.js";
import type { StorageProvider } from "../../storage/types.js";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { createHeartbeatRunOutput } from "../heartbeat/run-output.js";
import { compactRunLogChunk } from "../heartbeat/run-log.js";
import { createObjectRunLogStore } from "../object-run-log-store.js";
import { nativeSha256 } from "./canonical.js";
import { formatNativeRunLogEvent } from "./native-run-log-export.js";
import { readRecoverableRunLog, recoverSettledNativeRunLog } from "./native-run-log-recovery.js";

// Explicit opt-in only: never connect to an instance or an implicit local DB.
const url = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_LOG_WATERMARK_DATABASE_URL");

function memoryProvider(): StorageProvider {
  const objects = new Map<string, Buffer>();
  const etag = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  return {
    id: "s3",
    async putObject() { throw new Error("unconditional object write"); },
    async putObjectConditional(input) {
      const old = objects.get(input.objectKey);
      if (input.ifNoneMatch ? old : !old || etag(old) !== input.ifMatch)
        throw Object.assign(new Error("conflict"), { name: "PreconditionFailed" });
      const chunks: Buffer[] = [];
      for await (const chunk of Readable.from(input.body)) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      objects.set(input.objectKey, bytes);
      return { etag: etag(bytes) };
    },
    async getObject(input) {
      const bytes = objects.get(input.objectKey);
      if (!bytes) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { stream: Readable.from([bytes]), etag: etag(bytes) };
    },
    async headObject(input) { return { exists: objects.has(input.objectKey) }; },
    async deleteObject(input) { objects.delete(input.objectKey); },
    async listObjects(input) {
      return { keys: [...objects.keys()].filter((key) => key.startsWith(input.prefix)) };
    },
  };
}

describe.skipIf(!url)("native run log source watermarks", () => {
  const schema = `native_watermark_${randomUUID().replaceAll("-", "")}`;
  let db: Db;
  beforeAll(async () => {
    db = createDb(url!, { maxConnections: 1, idleTimeoutSeconds: 0 });
    await db.execute(sql.raw(`create schema ${schema}`));
    await db.execute(sql.raw(`set search_path=${schema}`));
    await createNativeRunLogTestTables(db);
    await db.execute(sql`create table instance_settings(id uuid primary key default gen_random_uuid(),
      singleton_key text unique default 'default', default_environment_id uuid,
      general jsonb not null default '{}', experimental jsonb not null default '{}',
      created_at timestamptz default now(), updated_at timestamptz default now())`);
    // Match the production queued-run default instead of the older native fixture default.
    await db.execute(sql`alter table heartbeat_runs alter column runtime_mode set default 'legacy'`);
  });
  afterAll(async () => {
    try {
      if (db) await db.execute(sql.raw(`drop schema ${schema} cascade`));
    } finally {
      await closeRegisteredClients(url!, { scope: "database" });
    }
  });

  async function fixture() {
    const binding = { companyId: randomUUID(), agentId: randomUUID(), runId: randomUUID() };
    await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,status)
      values(${binding.runId},${binding.companyId},${binding.agentId},'running')`);
    const provider = memoryProvider();
    const store = () => createObjectRunLogStore({
      provider, keyPrefix: "logs", flushMs: 1,
      assertWriterAuthority: async (input) => { await input.assertWriterAuthority?.(); },
    });
    const event = (seq: number): PrpEvent => ({
      schema: "paperclip.prp.event.v1", schemaVersion: 1,
      runId: binding.runId, sourceInstanceId: "fixture-source", sourceEventId: `source:${seq}`,
      sourceSeq: seq, sourceKind: "runner", normalizedSessionId: "fixture-session",
      eventType: seq === 2 ? "turn.interrupted" : "item.delta", priority: 2,
      emittedAt: "2026-10-31T00:00:00.000Z", payload: { text: `step ${seq} 再開` },
    });
    const persist = async (value: PrpEvent, cursor: number) => {
      await db.execute(sql`insert into heartbeat_run_events(company_id,run_id,agent_id,seq,event_type,
        payload,source_instance_id,source_event_id,source_seq,source_payload_sha256,protocol_schema_version)
        values(${binding.companyId},${binding.runId},${binding.agentId},${cursor},${value.eventType},
        ${JSON.stringify({ prpEvent: value })}::jsonb,${value.sourceInstanceId},${value.sourceEventId},
        ${value.sourceSeq},${nativeSha256(value)},${value.schemaVersion})`);
    };
    const settle = async (logRef: string) => {
      await db.update(heartbeatRuns).set({ runtimeMode: "native", status: "cancelled",
        logStore: "s3_segments", logRef, logBytes: null }).where(eq(heartbeatRuns.id, binding.runId));
    };
    return { binding, store, event, persist, settle };
  }

  it("records native cursors when output begins with the queued legacy default, then cancels and cold-reads without replay", async () => {
    const f = await fixture();
    const [persisted] = await db.select({ runtimeMode: heartbeatRuns.runtimeMode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, f.binding.runId));
    expect(persisted!.runtimeMode).toBe("legacy");
    const initialRow: Partial<typeof heartbeatRuns.$inferSelect> = {
      companyId: f.binding.companyId, agentId: f.binding.agentId,
      id: f.binding.runId, status: "running", ...persisted,
      logStore: null, logRef: null, logBytes: null, lastOutputSeq: 0, lastOutputAt: null,
    };
    const run = initialRow as typeof heartbeatRuns.$inferSelect;
    const store = f.store();
    const output = createHeartbeatRunOutput(db, {
      run, runId: run.id, issueId: null, runLogStore: store,
      identityRedactor: { chunk: (_stream, chunk) => chunk, redact: (value) => value },
      secretKeys: new Set(), appendRunEvent: async () => undefined,
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });
    const handlers = await output.begin(run);
    // Runtime selection persists a new row; the output closure retains the earlier row.
    await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, run.id));
    for (const cursor of [2, 5]) {
      const event = f.event(cursor === 2 ? 1 : 2);
      await f.persist(event, cursor);
      // This is the executor's persisted-native callback/fallback dispatch.
      const chunk = formatNativeRunLogEvent(event);
      if (handlers.onPersistedNativeLog) await handlers.onPersistedNativeLog(cursor, chunk);
      else await handlers.onLog("stdout", chunk);
    }
    await store.finalize(output.handle!);
    const prefix = (await store.read(output.handle!)).content;
    await f.settle(output.handle!.logRef);
    const cold = f.store();
    const read = await readRecoverableRunLog(db, cold, output.handle!, undefined,
      { runtimeMode: "native", status: "cancelled", logBytes: null });
    expect(read.content).toBe(prefix);
    const entries = read.content.trim().split("\n").map(line => JSON.parse(JSON.parse(line).chunk).event);
    expect(entries.map(event => event.sourceEventId)).toEqual(["source:1", "source:2"]);
    const resumed = await cold.begin(f.binding);
    expect(resumed.initialSourceCursor).toBe(5);
    await cold.finalize(resumed);
  });

  it("proves a zero-watermark prefix across JSONB key order and appends only the missing suffix", async () => {
    const f = await fixture(), store = f.store(), handle = await store.begin(f.binding);
    const events = Array.from({ length: 50 }, (_, index) => ({
      ...f.event(index + 1), payload: { text: `${index + 1} ${"再開".repeat(1000)}` },
    }));
    for (const [index, event] of events.entries()) await f.persist(event, (index + 1) * 2);
    const [durable] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, f.binding.runId)).limit(1);
    expect(JSON.stringify(durable!.payload!.prpEvent)).not.toBe(JSON.stringify(events[0]));
    await store.append(handle, { stream: "stdout", ts: "original", seq: 1, chunk: "preparation diagnostic\n" });
    for (const [index, event] of events.slice(0, 49).entries()) {
      await store.append(handle, { stream: "stdout", ts: "original", seq: index + 2,
        chunk: formatNativeRunLogEvent(event) });
    }
    await store.finalize(handle);
    const prefix = (await store.read(handle)).content;
    // The full prefix spans multiple byte pages and multiple 16-event source pages.
    let prefixOffset = Buffer.byteLength(prefix);
    let fullPrefix = prefix;
    for (;;) {
      const page = await store.read(handle, { offset: prefixOffset });
      fullPrefix += page.content;
      if (page.nextOffset === undefined) break;
      prefixOffset = page.nextOffset;
    }
    expect(Buffer.byteLength(fullPrefix)).toBeGreaterThan(256_000);
    await f.settle(handle.logRef);
    const cold = f.store();
    await recoverSettledNativeRunLog(db, cold, handle.logRef, async () => ({ enabled: false }));
    const content = (await cold.read(handle, { limitBytes: 1024 * 1024 })).content;
    expect(content.startsWith(fullPrefix)).toBe(true);
    const entries = content.trim().split("\n").map(line => JSON.parse(line));
    expect(entries.slice(1).map(entry => JSON.parse(entry.chunk).event.sourceSeq))
      .toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(entries.map(entry => entry.seq)).toEqual(Array.from({ length: 51 }, (_, index) => index + 1));
    const resumed = await cold.begin(f.binding);
    expect(resumed.initialSourceCursor).toBe(100);
    await cold.finalize(resumed);
  });

  it.each([true, false])("preserves an existing image prefix when base64 was omitted: %s", async (omitted) => {
    const f = await fixture(), store = f.store(), handle = await store.begin(f.binding);
    const data = "A".repeat(1024);
    const event = { ...f.event(1), payload: { image: { type: "image",
      source: omitted ? { type: "base64", data } : { data, type: "base64" },
    } } };
    await f.persist(event, 1);
    await f.persist(f.event(2), 2);
    const chunk = compactRunLogChunk(formatNativeRunLogEvent(event));
    expect(chunk.includes("[omitted base64 image data: 1024 chars]")).toBe(omitted);
    await store.append(handle, { stream: "stdout", ts: "original", seq: 1, chunk });
    await store.finalize(handle);
    const prefix = (await store.read(handle)).content;
    await f.settle(handle.logRef);
    const cold = f.store();
    await recoverSettledNativeRunLog(db, cold, handle.logRef, async () => ({ enabled: false }));
    const content = (await cold.read(handle)).content;
    expect(content.startsWith(prefix)).toBe(true);
    expect(content.trim().split("\n")).toHaveLength(2);
  });

  it("rejects conflicting raw image data even when the base64 length matches", async () => {
    const f = await fixture(), store = f.store(), handle = await store.begin(f.binding);
    const image = (data: string) => ({ ...f.event(1), payload: { image: {
      type: "image", source: { data, type: "base64" },
    } } });
    await f.persist(image("A".repeat(1024)), 1);
    await store.append(handle, { stream: "stdout", ts: "original", seq: 1,
      chunk: compactRunLogChunk(formatNativeRunLogEvent(image("B".repeat(1024)))) });
    await store.finalize(handle);
    const prefix = (await store.read(handle)).content;
    await f.settle(handle.logRef);
    const cold = f.store();
    await expect(recoverSettledNativeRunLog(db, cold, handle.logRef,
      async () => ({ enabled: false }))).rejects.toThrow("native_log_source_coverage_unproven");
    expect((await cold.read(handle)).content).toBe(prefix);
  });

  it("rejects an image omission marker in a non-image payload", async () => {
    const f = await fixture(), store = f.store(), handle = await store.begin(f.binding);
    const event = (data: string) => ({ ...f.event(1), payload: { file: {
      type: "file", source: { type: "base64", data },
    } } });
    await f.persist(event("A".repeat(1024)), 1);
    await store.append(handle, { stream: "stdout", ts: "original", seq: 1,
      chunk: formatNativeRunLogEvent(event("[omitted base64 image data: 1024 chars]")) });
    await store.finalize(handle);
    const prefix = (await store.read(handle)).content;
    await f.settle(handle.logRef);
    const cold = f.store();
    await expect(recoverSettledNativeRunLog(db, cold, handle.logRef,
      async () => ({ enabled: false }))).rejects.toThrow("native_log_source_coverage_unproven");
    expect((await cold.read(handle)).content).toBe(prefix);
  });

  for (const kind of ["conflicting", "malformed", "duplicate"] as const) {
    it(`leaves a ${kind} zero-watermark prefix unchanged and incomplete`, async () => {
      const f = await fixture(), store = f.store(), handle = await store.begin(f.binding);
      await f.persist(f.event(1), 1);
      await f.persist(f.event(2), 2);
      const chunk = kind === "conflicting"
        ? formatNativeRunLogEvent({ ...f.event(1), payload: { text: "different" } })
        : kind === "malformed" ? '{"type":"paperclip.prp.event","event":broken\n'
        : formatNativeRunLogEvent(f.event(1));
      await store.append(handle, { stream: "stdout", ts: "original", seq: 1, chunk });
      if (kind === "duplicate") await store.append(handle, { stream: "stdout", ts: "original", seq: 2, chunk });
      await store.finalize(handle);
      const prefix = (await store.read(handle)).content;
      await f.settle(handle.logRef);
      const cold = f.store();
      await expect(recoverSettledNativeRunLog(db, cold, handle.logRef,
        async () => ({ enabled: false }))).rejects.toThrow("native_log_source_coverage_unproven");
      expect((await cold.read(handle)).content).toBe(prefix);
      const [row] = await db.select({ bytes: heartbeatRuns.logBytes }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, f.binding.runId));
      expect(row!.bytes).toBeNull();
    });
  }
});
