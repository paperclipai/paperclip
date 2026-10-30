import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { Db, heartbeatRuns } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableRunLogStore } from "../run-log-store.js";
import type { StorageProvider } from "../../storage/types.js";
import { createHeartbeatRunOutput, isNewRunLog } from "./run-output.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { formatNativeRunLogEvent } from "../native-runtime/native-run-log-export.js";
import { generateKeyPairSync } from "node:crypto";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

type Run = typeof heartbeatRuns.$inferSelect;

function createMemoryProvider() {
  const objects = new Map<string, Buffer>();
  const calls = { head: 0, get: 0 };
  const provider: StorageProvider = {
    id: "s3",
    async putObject(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of Readable.from(input.body)) chunks.push(Buffer.from(chunk));
      objects.set(input.objectKey, Buffer.concat(chunks));
    },
    async getObject(input) {
      calls.get++;
      const buf = objects.get(input.objectKey)!;
      return { stream: Readable.from(buf), contentLength: buf.length };
    },
    async headObject(input) {
      calls.head++;
      const buf = objects.get(input.objectKey);
      return buf ? { exists: true, contentLength: buf.length } : { exists: false };
    },
    async deleteObject(input) {
      objects.delete(input.objectKey);
    },
  };
  return { provider, objects, calls };
}

// The recorder persists the handle with update().set().where(); capture it the
// way the run row would carry it into a later attempt.
function createRunRowDb(row: Partial<Run>) {
  return {
    update: () => ({
      set: (values: Partial<Run>) => ({
        where: async () => {
          Object.assign(row, values);
        },
      }),
    }),
  } as unknown as Db;
}

const newRunRow = {
  id: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  status: "running",
  logStore: null,
  logRef: null,
  logBytes: null,
  lastOutputSeq: 0,
  lastOutputAt: null,
} as Partial<Run>;

async function beginAttempt(store: ReturnType<typeof createDurableRunLogStore>, row: Partial<Run>) {
  const output = createHeartbeatRunOutput(createRunRowDb(row), {
    run: row as Run,
    runId: row.id!,
    issueId: null,
    runLogStore: store,
    identityRedactor: { chunk: (_stream, chunk) => chunk, redact: (value) => value },
    secretKeys: new Set(),
    appendRunEvent: vi.fn(),
    getCurrentUserRedactionOptions: async () => ({ enabled: false }),
  });
  const { onLog } = await output.begin({ ...row } as Run);
  return { output, onLog };
}

let baseDir: string;
beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-output-test-"));
});
afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe("heartbeat run output log recovery", () => {
  it("treats only a run row with no recorded log or output as new", () => {
    expect(isNewRunLog({ logStore: null, logRef: null, logBytes: null, lastOutputSeq: 0 })).toBe(
      true,
    );
    expect(
      isNewRunLog({
        logStore: "local_file",
        logRef: "c/a/r.ndjson",
        logBytes: null,
        lastOutputSeq: 0,
      }),
    ).toBe(false);
    expect(
      isNewRunLog({ logStore: null, logRef: "c/a/r.ndjson", logBytes: null, lastOutputSeq: 0 }),
    ).toBe(false);
    expect(isNewRunLog({ logStore: null, logRef: null, logBytes: null, lastOutputSeq: 3 })).toBe(
      false,
    );
    expect(isNewRunLog({ logStore: null, logRef: null, logBytes: 120, lastOutputSeq: 0 })).toBe(
      false,
    );
  });

  it("makes no remote log recovery request for a new run", async () => {
    const { provider, calls } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const row = { ...newRunRow };
    const { onLog } = await beginAttempt(store, row);
    await onLog("stdout", "hello\n");
    expect(calls).toEqual({ head: 0, get: 0 });
    expect(row.logRef).toBe(path.join("company-1", "agent-1", "run-1.ndjson"));
  });

  it("restores an existing attempt's durable log after local state is lost", async () => {
    const { provider, objects, calls } = createMemoryProvider();
    const row = { ...newRunRow };
    const firstStore = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const first = await beginAttempt(firstStore, row);
    await first.onLog("stdout", "attempt one\n");
    await firstStore.finalize(first.output.handle!);
    expect(calls).toEqual({ head: 0, get: 0 });

    // Process restart on a new pod: local logs and in-memory state are gone,
    // but the run row still records the earlier attempt's log.
    await fs.rm(baseDir, { recursive: true, force: true });
    const restartedStore = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const second = await beginAttempt(restartedStore, row);
    expect(calls).toEqual({ head: 1, get: 1 });
    await second.onLog("stdout", "attempt two\n");
    await restartedStore.finalize(second.output.handle!);

    const lines = objects
      .get(row.logRef!)!
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.chunk)).toEqual(["attempt one\n", "attempt two\n"]);
    expect(lines.map((line) => line.seq)).toEqual([1, 2]);
  });
});

describe("object-backed diagnostic recording", () => {
  it("applies identity redaction to a native key-bearing event before S3 admission", async () => {
    const privateKeyPem = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const row = { ...newRunRow, runtimeMode: "native" } as Run;
    const db = createRunRowDb(row) as Db & { select: () => unknown };
    db.select = (() => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
    })) as typeof db.select;
    const chunks: string[] = [];
    const output = createHeartbeatRunOutput(db, {
      run: row,
      runId: row.id,
      issueId: null,
      secretKeys: new Set(),
      identityRedactor: createAgentIdentityRedactor(privateKeyPem),
      runLogStore: {
        begin: async () => ({
          store: "s3_segments",
          logRef: "company/agent/run",
          initialSourceCursor: 0,
        }),
        append: async () => 0,
        enqueue: async (_handle, event) => {
          chunks.push(event.chunk);
          return { committed: Promise.resolve(100) };
        },
        flush: async () => undefined,
      },
      appendRunEvent: vi.fn(),
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });
    const handlers = await output.begin(row);
    await handlers.onPersistedNativeLog!(
      1,
      formatNativeRunLogEvent({
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        runId: row.id,
        sourceEventId: "source:1",
        sourceInstanceId: "source",
        sourceKind: "runner",
        sourceSeq: 1,
        normalizedSessionId: "session",
        eventType: "harness.diagnostic",
        priority: 1,
        emittedAt: new Date().toISOString(),
        payload: { text: privateKeyPem },
      }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).not.toContain(privateKeyPem.split("\n")[1]!);
    expect(chunks[0]).toContain("REDACTED");
  });
  it("admits a burst without serial network waits, publishes after receipts, and coalesces progress", async () => {
    const { publishLiveEvent } = await import("../live-events.js");
    vi.mocked(publishLiveEvent).mockClear();
    const row = { ...newRunRow };
    const writes: Array<Partial<Run>> = [];
    const db = {
      update: () => ({
        set: (values: Partial<Run>) => ({
          where: async () => {
            writes.push(values);
            Object.assign(row, values);
          },
        }),
      }),
    } as unknown as Db;
    const commit: Array<() => void> = [];
    const recorder = createHeartbeatRunOutput(db, {
      run: row as Run,
      runId: row.id!,
      issueId: null,
      runLogStore: {
        begin: async () => ({
          store: "s3_segments",
          logRef: "company/agent/run",
          initialBytes: 0,
          initialSequence: 10,
        }),
        append: () => new Promise<number>((resolve) => commit.push(() => resolve(100))),
      },
      identityRedactor: { chunk: (_stream, chunk) => chunk, redact: (value) => value },
      secretKeys: new Set(),
      appendRunEvent: vi.fn(),
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });
    const { onLog } = await recorder.begin(row as Run);
    for (let i = 0; i < 100; i++) await onLog("stdout", `line ${i}\n`);
    expect(commit).toHaveLength(100);
    expect(publishLiveEvent).not.toHaveBeenCalled();
    for (const resolve of commit) resolve();
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(publishLiveEvent)
          .mock.calls.filter(([event]) => event.type === "heartbeat.run.log"),
      ).toHaveLength(100),
    );
    await recorder.flushOutputProgress({ force: true });
    expect(row.lastOutputSeq).toBe(110);
    expect(row.lastOutputBytes).toBe(10000);
    expect(writes.filter((write) => write.lastOutputSeq !== undefined)).toHaveLength(2);
  });
});
