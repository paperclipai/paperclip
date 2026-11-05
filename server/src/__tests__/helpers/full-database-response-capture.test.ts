import { expect, it } from "vitest";
import { createFullDatabaseResponseCapture } from "./full-database-response-capture.js";

const metadata = { operation: "select", table: "heartbeat_runs", callers: [] };

it("measures every oversized string and complex value without sampling or truncation", () => {
  const events: Array<Record<string, unknown>> = [];
  const capture = createFullDatabaseResponseCapture({ start: 0, end: 1000 }, event => events.push(event), () => 0);
  const text = "private-payload🙂".repeat(30_000);
  const nested = { instructions: text, additional: [{ prompt: text }] };
  const rows = Object.assign([[text, nested]], { columns: [{ name: "stdout_excerpt" }, { name: "context_snapshot" }] });
  const bytes = Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(nested));
  try {
    for (let index = 0; index < 17; index++) expect(capture.execute(() => rows, metadata)).toBe(rows);
    capture.flush();
    expect(events[0]).toMatchObject({ event: "paperclip.test_db_response_capture.entry.v1",
      calls: 17, rows: 17, responseValueBytes: 17 * bytes, maxResponseValueBytes: bytes,
      estimatedValues: 17, serializationErrors: 0,
    });
    expect(events[1]).toMatchObject({ event: "paperclip.test_db_response_capture.summary.v1",
      startedQueries: 17, completedQueries: 17, inFlightAtEnd: 0, overflowCalls: 0, responseValueBytes: 17 * bytes,
    });
    expect(JSON.stringify(events)).not.toContain("private-payload");
    expect(nested.instructions).toBe(text);
  } finally { capture.flush(); }
});

it("preserves asynchronous results and original query errors", async () => {
  const events: Array<Record<string, unknown>> = [];
  const capture = createFullDatabaseResponseCapture({ start: 0, end: 1000 }, event => events.push(event), () => 0);
  const rows = Object.assign([{ value: { nested: "result" } }], { columns: [{ name: "value" }] });
  const failure = new Error("private query failure");
  try {
    await expect(capture.execute(async () => rows, metadata)).resolves.toBe(rows);
    await expect(capture.execute(async () => { throw failure; }, metadata)).rejects.toBe(failure);
    expect(() => capture.execute(() => { throw failure; }, metadata)).toThrow(failure);
    capture.flush();
    expect(events[0]).toMatchObject({ calls: 3, rows: 1, queryErrors: 2,
      responseValueBytes: Buffer.byteLength(JSON.stringify(rows[0].value)), serializationErrors: 0,
    });
    expect(events[1]).toMatchObject({ startedQueries: 3, completedQueries: 3, inFlightAtEnd: 0 });
    expect(JSON.stringify(events)).not.toContain(failure.message);
  } finally { capture.flush(); }
});

it("reports unfinished work at the deadline without cancelling it or counting a late result", async () => {
  const events: Array<Record<string, unknown>> = [];
  let now = 0;
  const capture = createFullDatabaseResponseCapture({ start: 0, end: 1000 }, event => events.push(event), () => now);
  let release!: (value: string[]) => void;
  const original = new Promise<string[]>(resolve => { release = resolve; });
  const pending = capture.execute(() => original, metadata);
  now = 1000;
  capture.flush();
  release(["result"]);
  await expect(pending).resolves.toEqual(["result"]);
  capture.flush();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event: "paperclip.test_db_response_capture.summary.v1",
    startedQueries: 1, completedQueries: 0, inFlightAtEnd: 1, responseValueBytes: 0,
  });
});
