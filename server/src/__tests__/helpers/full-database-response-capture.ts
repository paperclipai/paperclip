import { randomUUID } from "node:crypto";
import { createDatabaseResponseCapture, type ResponseCaptureWindow } from "@paperclipai/db/response-capture";

export { installDatabaseResponseCapture } from "@paperclipai/db/response-capture";

type Capture = ReturnType<typeof createDatabaseResponseCapture>;
type Metadata = Parameters<Capture["execute"]>[1];
type Entry = Metadata & { calls: number; rows: number; bytes: number; maxBytes: number;
  queryErrors: number; serializationErrors: number; estimatedValues: number };

function fullResponseValueSize(value: unknown): { bytes: number; estimatedValues: number } {
  const columns = value && typeof value === "object" ? (value as { columns?: unknown }).columns : undefined;
  if (!Array.isArray(value) || !Array.isArray(columns)) {
    const serialized = JSON.stringify(value, (_, item: unknown) => typeof item === "bigint" ? item.toString() : item);
    return { bytes: serialized === undefined ? 0 : Buffer.byteLength(serialized), estimatedValues: 1 };
  }
  let bytes = 0, estimatedValues = 0;
  for (const row of value) {
    const cells = Array.isArray(row) ? row : columns.map(column => row[column.name]);
    for (const cell of cells) {
      if (cell === null || cell === undefined) continue;
      if (typeof cell === "string") bytes += Buffer.byteLength(cell);
      else if (typeof cell === "boolean") bytes += 1;
      else if (typeof cell === "number" || typeof cell === "bigint") bytes += Buffer.byteLength(String(cell));
      else {
        estimatedValues += 1;
        const serialized = JSON.stringify(cell, (_, item: unknown) => typeof item === "bigint" ? item.toString() : item);
        if (serialized !== undefined) bytes += Buffer.byteLength(serialized);
      }
    }
  }
  return { bytes, estimatedValues };
}

export function createFullDatabaseResponseCapture(
  window: ResponseCaptureWindow,
  emit: (event: Record<string, unknown>) => void,
  now: () => number = Date.now,
): Capture {
  const capture = createDatabaseResponseCapture(window, () => {}, now);
  const id = randomUUID(), entries = new Map<string, Entry>();
  let closed = false, inFlight = 0, started = 0, completed = 0, overflowCalls = 0;
  const send = (event: Record<string, unknown>) => { try { emit(event); } catch {} };
  function flush() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    capture.flush();
    const ordered = [...entries.values()].sort((a, b) => b.bytes - a.bytes);
    for (const [groupIndex, entry] of ordered.entries()) send({
      event: "paperclip.test_db_response_capture.entry.v1", captureId: id,
      groupIndex, groupPage: Math.floor(groupIndex / 128),
      operation: entry.operation, table: entry.table, callers: entry.callers,
      calls: entry.calls, rows: entry.rows, responseValueBytes: entry.bytes,
      maxResponseValueBytes: entry.maxBytes, estimatedValues: entry.estimatedValues,
      queryErrors: entry.queryErrors, serializationErrors: entry.serializationErrors,
    });
    send({ event: "paperclip.test_db_response_capture.summary.v1", captureId: id,
      windowStart: new Date(window.start).toISOString(), windowEnd: new Date(window.end).toISOString(),
      closedAt: new Date(now()).toISOString(), startedQueries: started, completedQueries: completed,
      inFlightAtEnd: inFlight, groups: entries.size, groupPageSize: 128, groupPages: Math.ceil(ordered.length / 128),
      overflowCalls, responseValueBytes: ordered.reduce((sum, entry) => sum + entry.bytes, 0),
      rowValuesLogged: false, sqlOrParametersLogged: false, wireBytesMeasured: false,
      measurementBoundary: "postgres-js results before Drizzle column decoding",
      relationalQueriesMeasured: true, unsafeDriverQueriesMeasured: true,
      taggedDriverQueriesMeasured: false, streamingQueriesMeasured: false,
    });
    entries.clear();
  }
  const timer = setTimeout(flush, Math.max(0, window.end - now()));
  timer.unref();
  function finish(metadata: Metadata, value: unknown, failed: boolean) {
    if (!capture.active()) return;
    inFlight -= 1;
    completed += 1;
    let key = JSON.stringify(metadata);
    if (!entries.has(key) && entries.size >= 2047) {
      overflowCalls += 1;
      metadata = { operation: "other", table: "other", callers: [] };
      key = "overflow";
    }
    let entry = entries.get(key);
    if (!entry) {
      entry = { ...metadata, calls: 0, rows: 0, bytes: 0, maxBytes: 0,
        queryErrors: 0, serializationErrors: 0, estimatedValues: 0 };
      entries.set(key, entry);
    }
    entry.calls += 1;
    if (failed) { entry.queryErrors += 1; return; }
    entry.rows += Array.isArray(value) ? value.length : 0;
    try {
      const size = fullResponseValueSize(value);
      entry.bytes += size.bytes;
      entry.maxBytes = Math.max(entry.maxBytes, size.bytes);
      entry.estimatedValues += size.estimatedValues;
    } catch { entry.serializationErrors += 1; }
  }
  function execute(action: () => unknown, metadata: Metadata) {
    if (!capture.active()) return action();
    inFlight += 1;
    started += 1;
    let result: unknown;
    try { result = action(); }
    catch (error) { finish(metadata, undefined, true); throw error; }
    let asynchronous = false;
    try { asynchronous = Boolean(result && typeof (result as { then?: unknown }).then === "function"); } catch {}
    if (asynchronous) return Promise.resolve(result).then(
      value => { finish(metadata, value, false); return value; },
      error => { finish(metadata, undefined, true); throw error; },
    );
    finish(metadata, result, false);
    return result;
  }
  return { ...capture, execute, flush };
}
