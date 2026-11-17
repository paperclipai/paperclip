import { AsyncLocalStorage } from "node:async_hooks";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseResponseCapture, databaseResponseCaptureFromEnv, installDatabaseResponseCapture, publicDatabaseCallers, responseCaptureWindow, withDatabaseOperation } from "./response-capture.js";

const epoch = Date.parse("2020-01-01T00:00:00Z");
const metadata = { operation: "select", table: "capture_fixture", callers: ["services/fixture.ts:4:2"] };
const table = pgTable("capture_fixture", { id: integer("id") });
const captures: Array<ReturnType<typeof createDatabaseResponseCapture>> = [];
afterEach(() => { for (const capture of captures.splice(0)) capture.flush(); vi.unstubAllEnvs(); });
function fixture(emitOverride?: (event: Record<string, unknown>) => void) {
  let clock = epoch;
  const events: Array<Record<string, unknown>> = [];
  const capture = createDatabaseResponseCapture({ start: epoch, end: epoch + 60_000 }, emitOverride ?? (event => events.push(event)), () => clock);
  captures.push(capture);
  return { capture, events, now: (value: number) => { clock = value; } };
}
function driverRows(rows: unknown[][]) {
  return Object.assign(rows, { columns: Array.from({ length: rows[0]?.length ?? 0 }, (_, index) => ({ name: `column_${index}` })) });
}

describe("bounded database response capture", () => {
  it("paces a complete environment capture without extending the measurement window or leaving timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const emitted: Array<{ at: number; event: Record<string, unknown> }> = [];
    const log = vi.spyOn(console, "info").mockImplementation(value => emitted.push({ at: Date.now(), event: JSON.parse(value) }));
    try {
      const capture = databaseResponseCaptureFromEnv({ PAPERCLIP_DB_RESPONSE_CAPTURE_WINDOW: "2020-01-01T00:00:00Z/2020-01-01T00:01:00Z" })!;
      captures.push(capture);
      const rows = [{ secret: "capture-response-sentinel" }];
      for (let index = 0; index < 2200; index++) {
        expect(capture.execute(() => rows, { ...metadata, callers: [`services/capture.ts:${index + 1}:1`] })).toBe(rows);
      }
      vi.advanceTimersByTime(60_001);
      expect(emitted.length).toBeGreaterThan(0);
      expect(emitted.length).toBeLessThanOrEqual(64);
      expect(capture.active()).toBe(false);
      expect(capture.execute(() => rows, metadata)).toBe(rows);
      capture.flush();
      vi.advanceTimersByTime(32_000);
      expect(emitted).toHaveLength(2049);
      const groups = emitted.filter(item => item.event.event === "paperclip.db_response_capture.entry.v2");
      const summary = emitted.at(-1)!.event;
      expect(groups).toHaveLength(2048);
      expect(summary).toMatchObject({ event: "paperclip.db_response_capture.summary.v2", completedQueries: 2200,
        groups: 2048, closedAt: "2020-01-01T00:01:00.000Z" });
      expect(groups.reduce((calls, item) => calls + Number(item.event.calls), 0)).toBe(summary.completedQueries);
      expect(groups.reduce((bytes, item) => bytes + Number(item.event.sampledValueBytes), 0)).toBe(summary.sampledValueBytes);
      expect(groups.map(item => item.event.groupIndex)).toEqual(Array.from({ length: 2048 }, (_, index) => index));
      for (const { at } of emitted) expect(emitted.filter(item => item.at >= at && item.at < at + 1000).length).toBeLessThanOrEqual(64);
      expect(JSON.stringify(emitted)).not.toContain("capture-response-sentinel");
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(emitted).toHaveLength(2049);
    } finally { log.mockRestore(); vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("contains deferred logger failures and finishes its bounded output", () => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch + 120_000);
    const log = vi.spyOn(console, "info").mockImplementation(() => { throw new Error("fixture logger failure"); });
    try {
      const capture = databaseResponseCaptureFromEnv({ PAPERCLIP_DB_RESPONSE_CAPTURE_WINDOW: "2020-01-01T00:02:00Z/2020-01-01T00:03:00Z" })!;
      captures.push(capture);
      expect(capture.execute(() => 7, metadata)).toBe(7);
      expect(() => vi.advanceTimersByTime(60_001)).not.toThrow();
      expect(log).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { log.mockRestore(); vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each([undefined, "", "sentinel-invalid-input", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z/2020-01-01T00:00:00Z",
    "2020-01-01T00:00:00Z/2020-01-01T00:01:01Z", "2020-01-01T01:00:00Z/2020-01-01T01:01:00Z",
    "2020-01-01T00:00:00Z/2020-01-01T00:01:00Z/extra",
  ])("disables absent, malformed, expired, or unbounded windows: %s", value => {
    expect(responseCaptureWindow(value, epoch + 60_000)).toBeUndefined();
  });
  it("accepts a fixed future window of at most one minute", () => {
    expect(responseCaptureWindow("2020-01-01T00:01:00Z/2020-01-01T00:02:00Z", epoch))
      .toEqual({ start: epoch + 60_000, end: epoch + 120_000 });
    expect(() => createDatabaseResponseCapture({ start: epoch, end: epoch + 60_001 }, () => {})).toThrow("Invalid");
  });
  it("keeps only public server file locations from stacks", () => {
    const stack = ["Error: sentinel-message", "at f (/private/fixture/server/src/services/example.ts:4:2)",
      "at f (/private/fixture/server/src/services/example.ts:4:2)", "at f (/private/fixture/server/dist/routes/example.js:5:3)",
      "at f (/private/fixture/customer-file.js:7:9)", "at f (/app/server/src/services/../../customer-file.ts:8:1)"].join("\n");
    expect(publicDatabaseCallers(stack)).toEqual(["services/example.ts:4:2", "routes/example.js:5:3"]);
  });
  it("keeps one static bundled anchor and rejects dynamic paths or untrusted driver anchors", () => {
    expect(publicDatabaseCallers("at privateName (/app/server/dist-runtime/chunk-ABCDEFGH.mjs:12:34)\nat helper (/app/server/dist-runtime/server.mjs:56:78)", true))
      .toEqual(["dist-runtime/chunk-ABCDEFGH.mjs:12:34"]);
    for (const path of ["customer-name.mjs", "chunk-ABCDEFGH.mjs?private=1", "chunk-ABCDEFGH.mjs#private", "../server.mjs", "nested/server.mjs", "server.mjs:0:1", "server.mjs:9999999999:1"]) {
      expect(publicDatabaseCallers(`at privateName (/app/server/dist-runtime/${path}:12:34)`, true)).toEqual([]);
    }
    expect(publicDatabaseCallers("at f (/app/server/dist-runtime/server.mjs:12:34)")).toEqual([]);
  });
  it("leaves methods and identity unchanged when disabled", () => {
    vi.stubEnv("PAPERCLIP_DB_RESPONSE_CAPTURE_WINDOW", undefined);
    const db = { select: vi.fn(), transaction: vi.fn() }, select = db.select, transaction = db.transaction;
    expect(installDatabaseResponseCapture(db, { table })).toBe(db);
    expect(db.select).toBe(select); expect(db.transaction).toBe(transaction);
  });
  it("preserves exact values and only emits counts, sampled sizes, and caller metadata", async () => {
    const f = fixture(), text = "sentinel-result-value🙂\n\"", rows = driverRows([[text, 4n]]);
    expect(await f.capture.execute(() => Promise.resolve(rows), metadata)).toBe(rows);
    f.capture.flush();
    const entry = f.events.find(event => event.event === "paperclip.db_response_capture.entry.v2")!;
    expect(entry).toMatchObject({ calls: 1, rows: 1, queryErrors: 0, owner: "unattributed", sampledResults: 1,
      sampledValueBytes: Buffer.byteLength(text) + 1, measuredValues: 2, unmeasuredValues: 0, incompleteSamples: 0 });
    expect(JSON.stringify(f.events)).not.toContain("sentinel-result-value");
    expect(f.events.at(-1)).toMatchObject({ startedQueries: 1, completedQueries: 1, inFlightAtEnd: 0,
      rowValuesLogged: false, sqlOrParametersLogged: false, wireBytesMeasured: false });
  });
  it("counts driver text values without adding JSON escaping or column names", async () => {
    const f = fixture(), text = "sentinel-driver-text\n\"";
    const rows = Object.assign([[text, true, 42n, null]], { columns: [
      { name: "sentinel-column-name" }, { name: "b" }, { name: "n" }, { name: "empty" } ] });
    expect(await f.capture.execute(() => Promise.resolve(rows), metadata)).toBe(rows);
    f.capture.flush();
    expect(f.events[0]).toMatchObject({ sampledValueBytes: Buffer.byteLength(text) + 1 + 2, measuredValues: 4, unmeasuredValues: 0 });
    expect(JSON.stringify(f.events)).not.toContain("sentinel-driver-text");
    expect(JSON.stringify(f.events)).not.toContain("sentinel-column-name");
  });
  it("counts every result but sizes only the first and every sixteenth successful result per group", () => {
    const f = fixture();
    for (let index = 0; index < 33; index += 1) {
      const rows = driverRows([["abc", 12]]);
      if (index % 16 !== 0) Object.defineProperty(rows[0], 0, { get() { throw new Error("unsampled cell read"); } });
      expect(withDatabaseOperation("fixture.owner", () => f.capture.execute(() => rows, metadata))).toBe(rows);
    }
    f.capture.flush();
    expect(f.events[0]).toMatchObject({ owner: "fixture.owner", calls: 33, rows: 33, sampledResults: 3,
      sampledRows: 3, sampledValueBytes: 15, measuredValues: 6, unmeasuredValues: 0, incompleteSamples: 0 });
    expect(f.events[0].totalWallMs).toBeGreaterThanOrEqual(0);
    expect(f.events[0].maxWallMs).toBeLessThanOrEqual(Number(f.events[0].totalWallMs));
  });
  it("bounds sampled cells, string scanning, and bytes without traversing large or complex values", () => {
    const f = fixture();
    const rows = driverRows([["x".repeat(1_000_000), { large: "private-json" }, ...Array.from({ length: 300 }, () => "y".repeat(16_384))]]);
    Object.defineProperty(rows[0], 256, { get() { throw new Error("cell budget exceeded"); } });
    expect(f.capture.execute(() => rows, metadata)).toBe(rows);
    f.capture.flush();
    expect(f.events[0]).toMatchObject({ sampledResults: 1, sampledValueBytes: 65_536, measuredValues: 4,
      unmeasuredValues: 298, incompleteSamples: 1 });
    expect(JSON.stringify(f.events)).not.toContain("private-json");
    const cellBound = fixture(), cells = driverRows([Array.from({ length: 257 }, () => null)]);
    Object.defineProperty(cells[0], 256, { get() { throw new Error("cell budget exceeded"); } });
    cellBound.capture.execute(() => cells, metadata);
    cellBound.capture.flush();
    expect(cellBound.events[0]).toMatchObject({ sampledValueBytes: 0, measuredValues: 256, unmeasuredValues: 1, incompleteSamples: 1 });
  });
  it("restores nested owners and uses the direct path without an active capture", () => {
    const returned = Promise.resolve("unchanged");
    expect(withDatabaseOperation("disabled", () => returned)).toBe(returned);
    const f = fixture();
    withDatabaseOperation("outer", () => {
      withDatabaseOperation("inner", () => f.capture.execute(() => driverRows([[1]]), metadata));
      f.capture.execute(() => driverRows([[2]]), metadata);
    });
    f.now(epoch + 60_001);
    withDatabaseOperation("expired", () => {
      const next = fixture();
      next.capture.execute(() => driverRows([[3]]), metadata);
      next.capture.flush();
      expect(next.events[0]).toMatchObject({ owner: "unattributed" });
    });
    f.capture.flush();
    expect(f.events.slice(0, -1).map(event => event.owner).sort()).toEqual(["inner", "outer"]);
  });
  it("retains an armed operation across the capture start without counting earlier queries", async () => {
    let clock = epoch;
    const events: Array<Record<string, unknown>> = [];
    const capture = createDatabaseResponseCapture({ start: epoch + 1_000, end: epoch + 60_000 }, event => events.push(event), () => clock);
    captures.push(capture);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = withDatabaseOperation("started.before.window", async () => {
      capture.execute(() => driverRows([[1]]), metadata);
      await gate;
      return capture.execute(() => driverRows([[2]]), metadata);
    });
    clock = epoch + 2_000;
    release();
    await pending;
    capture.flush();
    expect(events[0]).toMatchObject({ owner: "started.before.window", calls: 1, rows: 1 });
    expect(events.at(-1)).toMatchObject({ startedQueries: 1, completedQueries: 1 });
  });
  it("keeps overlapping capture scopes but clears retained owners when the last capture closes", () => {
    const first = fixture(), second = fixture();
    let destination = second.capture;
    const retained = withDatabaseOperation("previous.capture", () => AsyncLocalStorage.bind(() =>
      destination.execute(() => driverRows([[1]]), metadata)));
    first.capture.flush();
    retained();
    second.capture.flush();
    expect(second.events[0]).toMatchObject({ owner: "previous.capture", calls: 1 });
    const later = fixture();
    destination = later.capture;
    withDatabaseOperation("new.capture", () => destination.execute(() => driverRows([[2]]), metadata));
    retained();
    later.capture.flush();
    expect(later.events.slice(0, -1).map(event => event.owner).sort()).toEqual(["new.capture", "unattributed"]);
  });
  it("does not alter synchronous or asynchronous errors or retry them", async () => {
    const f = fixture(), error = new Error("sentinel-private-error");
    const sync = vi.fn(() => { throw error; }), asyncFailure = vi.fn(() => Promise.reject(error));
    expect(() => f.capture.execute(sync, metadata)).toThrow(error);
    await expect(f.capture.execute(asyncFailure, metadata)).rejects.toBe(error);
    expect(sync).toHaveBeenCalledTimes(1); expect(asyncFailure).toHaveBeenCalledTimes(1);
    f.capture.flush();
    expect(f.events[0]).toMatchObject({ calls: 2, queryErrors: 2, sampledValueBytes: 0 });
    expect(JSON.stringify(f.events)).not.toContain("sentinel-private-error");
  });
  it("does not serialize complex values or let logging failures change query outcomes", () => {
    const f = fixture(), circular: Record<string, unknown> = {}; circular.self = circular;
    const toJSON = vi.fn(() => { throw new Error("must not serialize"); });
    const rows = driverRows([[circular, { toJSON }]]);
    expect(f.capture.execute(() => rows, metadata)).toBe(rows);
    f.capture.flush();
    expect(f.events[0]).toMatchObject({ calls: 1, sampledValueBytes: 0, unmeasuredValues: 2, incompleteSamples: 1 });
    expect(toJSON).not.toHaveBeenCalled();
    const brokenLogger = fixture(() => { throw new Error("logger fixture"); });
    expect(brokenLogger.capture.execute(() => circular, metadata)).toBe(circular);
    expect(() => brokenLogger.capture.flush()).not.toThrow();
  });
  it("stops accounting at the deadline and leaves in-flight work untouched", async () => {
    const f = fixture();
    let resolve!: (rows: unknown[]) => void;
    const pending = new Promise<unknown[]>(done => { resolve = done; });
    const result = f.capture.execute(() => pending, metadata);
    f.now(epoch + 60_000); f.capture.flush();
    expect(f.events.at(-1)).toMatchObject({ startedQueries: 1, completedQueries: 0, inFlightAtEnd: 1 });
    const rows = [{ marker: "late-result-value" }]; resolve(rows);
    expect(await result).toBe(rows);
    const direct = Promise.resolve(rows);
    expect(f.capture.execute(() => direct, metadata)).toBe(direct);
    expect(f.events).toHaveLength(1);
  });
  it("retains the deadline count when a query resolves before a delayed flush", async () => {
    const f = fixture();
    let resolve!: (rows: unknown[]) => void;
    const pending = new Promise<unknown[]>(done => { resolve = done; });
    const result = f.capture.execute(() => pending, metadata);
    f.now(epoch + 60_001);
    const rows = [{ marker: "late-before-flush-sentinel" }]; resolve(rows);
    expect(await result).toBe(rows);
    f.capture.flush();
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ startedQueries: 1, completedQueries: 0, inFlightAtEnd: 1, sampledValueBytes: 0 });
    expect(JSON.stringify(f.events)).not.toContain("late-before-flush-sentinel");
  });
  it("bounds cardinality while distinguishing sampled bytes from complete call and row counts", () => {
    const f = fixture();
    for (let i = 0; i < 2200; i += 1) f.capture.execute(() => driverRows([[i]]), { ...metadata, callers: [`services/f${i}.ts:1:1`] });
    f.capture.flush();
    const summary = f.events.at(-1)!;
    expect(summary).toMatchObject({ startedQueries: 2200, completedQueries: 2200, groups: 2048, overflowCalls: 153,
      groupPageSize: 128, groupPages: 16 });
    expect(f.events).toHaveLength(2049);
    const entries = f.events.slice(0, -1);
    expect(entries.map(entry => entry.groupIndex)).toEqual(Array.from({ length: 2048 }, (_, index) => index));
    for (let page = 0; page < 16; page += 1) {
      expect(entries.filter(entry => entry.groupPage === page)).toHaveLength(128);
    }
    expect(entries.reduce((sum, entry) => sum + Number(entry.calls), 0)).toBe(2200);
    expect(summary).toMatchObject({ rows: 2200, sampledResults: 2057, sampleEvery: 16 });
    expect(summary.sampledValueBytes).toBe(entries.reduce((sum, entry) => sum + Number(entry.sampledValueBytes), 0));
  });
  it.each([0, 129])("numbers every page including an empty or partial final page (%s)", count => {
    const f = fixture();
    for (let index = 0; index < count; index += 1) {
      f.capture.execute(() => [index], { ...metadata, callers: [`services/page${index}.ts:1:1`] });
    }
    f.capture.flush();
    const entries = f.events.slice(0, -1), summary = f.events.at(-1)!;
    expect(summary).toMatchObject({ groups: count, groupPageSize: 128, groupPages: Math.ceil(count / 128) });
    expect(entries.map(entry => entry.groupIndex)).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(entries.filter(entry => entry.groupPage === 0)).toHaveLength(Math.min(count, 128));
    expect(entries.filter(entry => entry.groupPage === 1)).toHaveLength(Math.max(0, count - 128));
  });
  it("does not execute builders or prepared statements until requested", async () => {
    const f = fixture(), rows = [{ id: 1 }], execute = vi.fn(async () => rows);
    const query = { execute, prepare: () => ({ execute }) };
    const builder = { from: () => query };
    const db = { select: () => builder };
    expect(installDatabaseResponseCapture(db, { table }, f.capture)).toBe(db);
    expect(db.select()).toBe(builder);
    expect(db.select().from()).toBe(query);
    expect(execute).not.toHaveBeenCalled();
    const prepared = query.prepare();
    expect(execute).not.toHaveBeenCalled();
    expect(await prepared.execute()).toBe(rows);
    expect(await query.execute()).toBe(rows);
    expect(execute).toHaveBeenCalledTimes(2);
    f.capture.flush();
    expect(f.events.at(-1)).toMatchObject({ completedQueries: 0 });
  });
});
