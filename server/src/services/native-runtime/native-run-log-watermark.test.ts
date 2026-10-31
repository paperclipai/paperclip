import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import { closeRegisteredClients, createDb, heartbeatRunEvents, heartbeatRuns, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { createNativeRunLogTestTables } from "../../__tests__/helpers/native-run-log-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import type { StorageProvider } from "../../storage/types.js";
import { validatePrpEvent, type PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { instanceSettingsService } from "../instance-settings.js";
import type { CurrentUserRedactionOptions } from "../../log-redaction.js";
import { createHeartbeatRunOutput } from "../heartbeat/run-output.js";
import { compactRunLogChunk } from "../heartbeat/run-log.js";
import { createObjectRunLogStore } from "../object-run-log-store.js";
import { nativeSha256 } from "./canonical.js";
import { formatNativeRunLogEvent } from "./native-run-log-export.js";
import { readRecoverableRunLog, recoverSettledNativeRunLog } from "./native-run-log-recovery.js";

// Use an explicit guarded test database or a new owned embedded fixture.
const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_LOG_WATERMARK_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

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

describe.skipIf(!support.supported)("native run log source watermarks", () => {
  const schema = `native_watermark_${randomUUID().replaceAll("-", "")}`;
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = externalUrl ? { connectionString: externalUrl, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("native-log-watermark-");
    db = createDb(database.connectionString, { maxConnections: 1, idleTimeoutSeconds: 0 });
    await db.execute(sql.raw(`create schema ${schema}`));
    await db.execute(sql.raw(`set search_path=${schema}`));
    await createNativeRunLogTestTables(db);
    await db.execute(sql`create table instance_settings(id uuid primary key default gen_random_uuid(),
      singleton_key text unique default 'default', default_environment_id uuid,
      general jsonb not null default '{}', experimental jsonb not null default '{}',
      created_at timestamptz default now(), updated_at timestamptz default now())`);
    // Match the production queued-run default instead of the older native fixture default.
    await db.execute(sql`alter table heartbeat_runs alter column runtime_mode set default 'legacy'`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    try {
      if (db) await db.execute(sql.raw(`drop schema ${schema} cascade`));
    } finally {
      if (database) {
        await closeRegisteredClients(database.connectionString, { scope: "database" });
        await database.cleanup();
      }
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
      expect(validatePrpEvent(value).ok).toBe(true);
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

  function toolEvent(f: Awaited<ReturnType<typeof fixture>>, output: string): PrpEvent {
    return { ...f.event(1), itemId: "tool-1", priority: 1, eventType: "tool.execution.completed", payload: {
      schema: "paperclip.tool.execution.v1", executionId: "tool-1", transport: "process",
      operation: "execute", status: "completed", output,
      outputBytes: Buffer.byteLength(output), outputTruncated: false, outputDigest: null, exitCode: 0,
    } };
  }

  async function publishProductionPrefix(
    f: Awaited<ReturnType<typeof fixture>>, event: PrpEvent,
    options: { watermark?: boolean; redaction?: () => Promise<CurrentUserRedactionOptions> } = {},
  ) {
    const [saved] = await db.select({ runtimeMode: heartbeatRuns.runtimeMode }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.binding.runId));
    const row = { id: f.binding.runId, companyId: f.binding.companyId, agentId: f.binding.agentId,
      status: "running", runtimeMode: saved!.runtimeMode, logStore: null, logRef: null,
      logBytes: null, lastOutputSeq: 0, lastOutputAt: null } as typeof heartbeatRuns.$inferSelect;
    const store = f.store();
    const output = createHeartbeatRunOutput(db, {
      run: row!, runId: row!.id, issueId: null, runLogStore: store,
      identityRedactor: { chunk: (_stream, chunk) => chunk, redact: value => value },
      secretKeys: new Set(), appendRunEvent: async () => undefined,
      getCurrentUserRedactionOptions: options.redaction ?? (async () => ({ enabled: false })),
    });
    const handlers = await output.begin(row!);
    await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, row!.id));
    await f.persist(event, 2);
    // Historical queued-run writers used onLog before source cursors were retained.
    if (options.watermark === false) await handlers.onLog("stdout", formatNativeRunLogEvent(event));
    else await handlers.onPersistedNativeLog!(2, formatNativeRunLogEvent(event));
    await store.finalize(output.handle!);
    return { store, handle: output.handle!, prefix: (await store.read(output.handle!)).content };
  }

  it.each([true, false])("cold-recovers a production-compacted 64KiB tool event with committed cursor: %s", async (watermark) => {
    const f = await fixture();
    const event = toolEvent(f, "retained output 再開 ".repeat(4000).slice(0, 65_536));
    const { handle, prefix } = await publishProductionPrefix(f, event, { watermark });
    const chunk = JSON.parse(prefix).chunk as string;
    expect(chunk).toContain("[paperclip truncated run log chunk: omitted ");
    expect(() => JSON.parse(chunk)).toThrow();
    const [durable] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, f.binding.runId));
    expect(JSON.stringify(durable!.payload!.prpEvent)).not.toBe(JSON.stringify(event));
    await f.persist(f.event(2), 5);
    await f.settle(handle.logRef);
    const cold = f.store();
    await recoverSettledNativeRunLog(db, cold, handle.logRef, async () => ({ enabled: false }));
    const content = (await cold.read(handle)).content;
    expect(content.startsWith(prefix)).toBe(true);
    const lines = content.trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].chunk).toBe(chunk);
    expect(JSON.parse(lines[1].chunk).event.sourceEventId).toBe("source:2");
    const [run] = await db.select({ bytes: heartbeatRuns.logBytes }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.binding.runId));
    expect(run!.bytes).toBe(Buffer.byteLength(content));
  });

  it.each([true, false])("retains a zero-watermark production prefix when username masking changes from %s", async (enabled) => {
    const f = await fixture();
    const setMasking = async (value: boolean) => db.execute(sql`insert into instance_settings(general)
      values(${JSON.stringify({ censorUsernameInLogs: value })}::jsonb)
      on conflict(singleton_key) do update set general=excluded.general`);
    const redaction = async () => ({ enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
      userNames: ["fixture-operator"], homeDirs: ["/home/fixture-operator"] });
    await setMasking(enabled);
    const event = { ...f.event(1), payload: { text: "fixture-operator owns /home/fixture-operator/file.txt" } };
    const { handle, prefix } = await publishProductionPrefix(f, event, { watermark: false, redaction });
    expect(prefix.includes("fixture-operator")).toBe(!enabled);
    await setMasking(!enabled);
    await f.persist({ ...f.event(2), payload: event.payload }, 5);
    await f.settle(handle.logRef);
    const cold = f.store();
    await recoverSettledNativeRunLog(db, cold, handle.logRef, redaction);
    const content = (await cold.read(handle)).content;
    expect(content.startsWith(prefix)).toBe(true);
    const lines = content.trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1].chunk.includes("fixture-operator")).toBe(enabled);
  });

  it("rejects a historical duplicate prefix even when the second copy advanced the journal cursor", async () => {
    const f = await fixture(), store = f.store(), handle = await store.begin(f.binding);
    const event = f.event(1), chunk = formatNativeRunLogEvent(event);
    await f.persist(event, 2);
    await f.persist(f.event(2), 5);
    await store.append(handle, { stream: "stdout", ts: "old-unwatermarked", seq: 1, chunk });
    await store.append(handle, { stream: "stdout", ts: "old-repair", seq: 2, sourceCursor: 2, chunk });
    await store.finalize(handle);
    const prefix = (await store.read(handle)).content;
    const oldHead = await store.begin(f.binding);
    expect(oldHead.initialSourceCursor).toBe(2);
    await store.finalize(oldHead);
    await f.settle(handle.logRef);
    const cold = f.store();
    await expect(recoverSettledNativeRunLog(db, cold, handle.logRef,
      async () => ({ enabled: false }))).rejects.toThrow("native_log_source_coverage_unproven");
    expect((await cold.read(handle)).content).toBe(prefix);
    const [run] = await db.select({ bytes: heartbeatRuns.logBytes }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.binding.runId));
    expect(run!.bytes).toBeNull();
  });

  it("fully verifies a valid legacy nonzero prefix once, then resumes with bounded verified provenance", async () => {
    const f = await fixture(), store = f.store(), handle = await store.begin(f.binding);
    await f.persist(f.event(1), 2);
    await store.append(handle, { stream: "stdout", ts: "legacy", seq: 1, sourceCursor: 2,
      chunk: formatNativeRunLogEvent(f.event(1)) });
    await store.finalize(handle);
    const prefix = (await store.read(handle)).content;
    await f.persist(f.event(2), 5);
    await f.settle(handle.logRef);
    const cold = f.store(), read = cold.read;
    let bytesRead = 0;
    cold.read = async (...args) => {
      const result = await read(...args); bytesRead += Buffer.byteLength(result.content); return result;
    };
    await recoverSettledNativeRunLog(db, cold, handle.logRef, async () => ({ enabled: false }));
    expect(bytesRead).toBeGreaterThanOrEqual(Buffer.byteLength(prefix));
    const repaired = (await read(handle)).content;
    expect(repaired.startsWith(prefix)).toBe(true);
    expect(repaired.trim().split("\n")).toHaveLength(2);
    await f.settle(handle.logRef);
    bytesRead = 0;
    await recoverSettledNativeRunLog(db, cold, handle.logRef, async () => ({ enabled: false }));
    expect(bytesRead).toBe(0);
    expect((await read(handle)).content).toBe(repaired);
  });

  it("uses bounded committed-cursor proof even after a long non-native diagnostic tail", async () => {
    const f = await fixture();
    const { store, handle } = await publishProductionPrefix(f, f.event(1));
    const writer = await store.begin(f.binding);
    for (let index = 0; index < 50; index++) await store.append(writer, {
      stream: "stderr", ts: "diagnostic", seq: index + 2, chunk: "diagnostic ".repeat(3000),
      preservesSourceCoverage: true,
    });
    await store.finalize(writer);
    const before = await store.begin(f.binding);
    expect(before.initialBytes).toBeGreaterThan(1_000_000);
    expect(before.initialSourceCursor).toBe(2);
    await store.finalize(before);
    await f.persist(f.event(2), 5);
    await f.settle(handle.logRef);
    const cold = f.store(), originalRead = cold.read;
    let prefixBytesRead = 0;
    cold.read = async (...args) => {
      const result = await originalRead(...args);
      prefixBytesRead += Buffer.byteLength(result.content);
      return result;
    };
    await recoverSettledNativeRunLog(db, cold, handle.logRef, async () => ({ enabled: false }));
    expect(prefixBytesRead).toBe(0);
    const content = (await originalRead(handle, { limitBytes: 4 * 1024 * 1024 })).content;
    const chunks = content.trim().split("\n").map(line => JSON.parse(line).chunk as string);
    expect(chunks).toHaveLength(52);
    expect(JSON.parse(chunks[0]!).event.sourceEventId).toBe("source:1");
    expect(chunks.slice(1, -1).every(chunk => chunk.startsWith("diagnostic "))).toBe(true);
    expect(JSON.parse(chunks.at(-1)!).event.sourceEventId).toBe("source:2");
  });

  it.each(["visible-content", "foreign", "order"] as const)("rejects a compacted zero-watermark prefix with %s corruption", async kind => {
    const f = await fixture(), store = f.store(), handle = await store.begin(f.binding);
    const event = toolEvent(f, "retained output ".repeat(5000).slice(0, 65_536));
    await f.persist(event, 2);
    await f.persist(f.event(2), 5);
    const published = kind === "foreign" ? { ...event, runId: randomUUID() } : event;
    let chunk = compactRunLogChunk(formatNativeRunLogEvent(published));
    if (kind === "visible-content") chunk = chunk.replace("retained output", "changed! output");
    if (kind === "order") await store.append(handle, { stream: "stdout", ts: "original", seq: 1,
      chunk: formatNativeRunLogEvent(f.event(2)) });
    await store.append(handle, { stream: "stdout", ts: "original", seq: kind === "order" ? 2 : 1, chunk });
    await store.finalize(handle);
    const prefix = (await store.read(handle)).content;
    await f.settle(handle.logRef);
    const cold = f.store();
    await expect(recoverSettledNativeRunLog(db, cold, handle.logRef,
      async () => ({ enabled: false }))).rejects.toThrow("native_log_source_coverage_unproven");
    expect((await cold.read(handle)).content).toBe(prefix);
  });

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
