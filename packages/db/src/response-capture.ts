import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getTableName, is, Table } from "drizzle-orm";

type Metadata = { operation: string; table: string; callers: string[] };
type Entry = Metadata & { owner: string; calls: number; rows: number; queryErrors: number; totalWallMs: number; maxWallMs: number;
  sampledResults: number; sampledRows: number; sampledValueBytes: number; maxSampledValueBytes: number;
  measuredValues: number; unmeasuredValues: number; incompleteSamples: number; sizingWallMs: number };
type Event = Record<string, unknown>;
type Method = (this: unknown, ...args: unknown[]) => unknown;
export type ResponseCaptureWindow = { start: number; end: number };
const GROUP_PAGE_SIZE = 128;
const SAMPLE_EVERY = 16;
const MAX_SAMPLE_CELLS = 256;
const MAX_SAMPLE_STRING_LENGTH = 16_384;
const MAX_SAMPLE_STRING_UNITS = 65_536;
const MAX_SAMPLE_BYTES = 65_536;
let operationScope = new AsyncLocalStorage<string>();
const captureWindows = new Set<() => boolean>();

export function withDatabaseOperation<T>(owner: string, action: () => T): T {
  for (const armed of captureWindows) {
    if (armed()) return operationScope.run(owner, action);
  }
  return action();
}

export function responseCaptureWindow(value: string | undefined, now = Date.now()): ResponseCaptureWindow | undefined {
  if (!value) return;
  const parts = value.split("/");
  if (parts.length !== 2 || parts.some(part => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(part))) return;
  const start = Date.parse(parts[0]!), end = Date.parse(parts[1]!);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 60_000 || end <= now || start > now + 30 * 60_000) return;
  return { start, end };
}

export function publicDatabaseCallers(stack: string | undefined): string[] {
  const callers: string[] = [];
  for (const line of (stack ?? "").split("\n")) {
    const match = line.match(/[/\\]server[/\\](?:src|dist)[/\\]((?:services|routes|modules|middleware)[/\\][A-Za-z0-9_./\\-]+\.[cm]?[jt]s):(\d+):(\d+)/);
    if (!match) continue;
    const relative = match[1]!.replaceAll("\\", "/");
    if (relative.split("/").includes("..")) continue;
    const caller = `${relative}:${match[2]}:${match[3]}`;
    if (!callers.includes(caller)) callers.push(caller);
    if (callers.length === 4) break;
  }
  return callers;
}

function responseValueSize(value: unknown): { bytes: number; measuredValues: number; unmeasuredValues: number } {
  const columns = value && typeof value === "object" ? (value as { columns?: unknown }).columns : undefined;
  if (!Array.isArray(value) || !Array.isArray(columns)) {
    return { bytes: 0, measuredValues: 0, unmeasuredValues: 1 };
  }
  let bytes = 0, measuredValues = 0, visitedValues = 0, stringUnits = 0;
  const totalValues = value.length * columns.length;
  if (columns.length === 0) return { bytes: 0, measuredValues: 0, unmeasuredValues: 0 };
  for (const row of value) {
    for (let index = 0; index < columns.length; index += 1) {
      if (visitedValues >= MAX_SAMPLE_CELLS || bytes >= MAX_SAMPLE_BYTES) {
        return { bytes, measuredValues, unmeasuredValues: totalValues - measuredValues };
      }
      visitedValues += 1;
      const cell = Array.isArray(row) ? row[index] : row[columns[index].name];
      let size: number;
      if (cell === null || cell === undefined) size = 0;
      else if (typeof cell === "string") {
        if (cell.length > MAX_SAMPLE_STRING_LENGTH || stringUnits + cell.length > MAX_SAMPLE_STRING_UNITS) continue;
        stringUnits += cell.length;
        size = Buffer.byteLength(cell);
      } else if (typeof cell === "boolean") size = 1;
      else if (typeof cell === "number") size = Buffer.byteLength(String(cell));
      else if (typeof cell === "bigint" && cell >= -9_223_372_036_854_775_808n && cell <= 9_223_372_036_854_775_807n) size = Buffer.byteLength(String(cell));
      else continue;
      if (bytes + size > MAX_SAMPLE_BYTES) continue;
      measuredValues += 1;
      bytes += size;
    }
  }
  return { bytes, measuredValues, unmeasuredValues: totalValues - measuredValues };
}

export function createDatabaseResponseCapture(
  window: ResponseCaptureWindow,
  emit: (event: Event) => void,
  now: () => number = Date.now,
) {
  if (!Number.isFinite(new Date(window.start).getTime()) || !Number.isFinite(new Date(window.end).getTime()) ||
      window.end <= window.start || window.end - window.start > 60_000) throw new Error("Invalid database response capture window");
  const id = randomUUID(), entries = new Map<string, Entry>();
  const roots = new WeakSet<object>(), queries = new WeakSet<object>(), factories = new WeakSet<object>();
  const clients = new WeakSet<object>(), driverQueries = new WeakSet<object>();
  const scope = new AsyncLocalStorage<Metadata>();
  let closed = false, inFlight = 0, started = 0, completed = 0, overflowCalls = 0;
  const send = (event: Event) => { try { emit(event); } catch {} };
  const expired = () => closed || now() >= window.end;
  const active = () => !expired() && now() >= window.start;
  const armed = () => !expired();
  captureWindows.add(armed);
  const flush = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    captureWindows.delete(armed);
    if (captureWindows.size === 0) {
      operationScope.disable();
      operationScope = new AsyncLocalStorage<string>();
    }
    scope.disable();
    const ordered = [...entries.values()].sort((a, b) => b.calls - a.calls);
    for (const [groupIndex, entry] of ordered.entries()) send({ event: "paperclip.db_response_capture.entry.v2", captureId: id,
      groupIndex, groupPage: Math.floor(groupIndex / GROUP_PAGE_SIZE),
      ...entry });
    send({ event: "paperclip.db_response_capture.summary.v2", captureId: id,
      windowStart: new Date(window.start).toISOString(), windowEnd: new Date(window.end).toISOString(),
      closedAt: new Date(now()).toISOString(),
      startedQueries: started, completedQueries: completed, inFlightAtEnd: inFlight, groups: entries.size,
      groupPageSize: GROUP_PAGE_SIZE, groupPages: Math.ceil(ordered.length / GROUP_PAGE_SIZE),
      overflowCalls, rows: ordered.reduce((sum, entry) => sum + entry.rows, 0),
      sampledResults: ordered.reduce((sum, entry) => sum + entry.sampledResults, 0),
      sampledValueBytes: ordered.reduce((sum, entry) => sum + entry.sampledValueBytes, 0),
      sizingWallMs: ordered.reduce((sum, entry) => sum + entry.sizingWallMs, 0),
      sampleEvery: SAMPLE_EVERY, sampling: "first-and-every-16th-successful-result-per-group",
      maxSampleCells: MAX_SAMPLE_CELLS, maxSampleStringLength: MAX_SAMPLE_STRING_LENGTH,
      maxSampleStringUnits: MAX_SAMPLE_STRING_UNITS, maxSampleBytes: MAX_SAMPLE_BYTES,
      rowValuesLogged: false, sqlOrParametersLogged: false, wireBytesMeasured: false,
      measurementBoundary: "postgres-js results before Drizzle column decoding",
      wallTimeBoundary: "first query consumption to driver result; includes queue, database, network and event-loop waits; not CPU",
      byteMeasurement: "sampled primitive values only; complex/oversized/budget-exceeding values unmeasured; no extrapolation",
      relationalQueriesMeasured: true, unsafeDriverQueriesMeasured: true,
      taggedDriverQueriesMeasured: false, streamingQueriesMeasured: false });
    entries.clear();
  };
  const timer = setTimeout(flush, Math.max(0, window.end - now()));
  timer.unref();
  function finish(metadata: Metadata & { owner: string }, value: unknown, failed: boolean, startedAt: number) {
    if (!active()) return;
    inFlight -= 1;
    completed += 1;
    try {
      let key = JSON.stringify(metadata);
      if (!entries.has(key) && entries.size >= 2047) {
        overflowCalls += 1;
        metadata = { owner: "other", operation: "other", table: "other", callers: [] };
        key = "overflow";
      }
      let entry = entries.get(key);
      if (!entry) {
        entry = { ...metadata, calls: 0, rows: 0, queryErrors: 0, totalWallMs: 0, maxWallMs: 0,
          sampledResults: 0, sampledRows: 0, sampledValueBytes: 0, maxSampledValueBytes: 0,
          measuredValues: 0, unmeasuredValues: 0, incompleteSamples: 0, sizingWallMs: 0 };
        entries.set(key, entry);
      }
      entry.calls += 1;
      const wallMs = performance.now() - startedAt;
      entry.totalWallMs += wallMs;
      entry.maxWallMs = Math.max(entry.maxWallMs, wallMs);
      if (failed) { entry.queryErrors += 1; return; }
      entry.rows += Array.isArray(value) ? value.length : 0;
      if ((entry.calls - entry.queryErrors - 1) % SAMPLE_EVERY !== 0) return;
      entry.sampledResults += 1;
      entry.sampledRows += Array.isArray(value) ? value.length : 0;
      const sizingStartedAt = performance.now();
      try {
        const size = responseValueSize(value);
        entry.sampledValueBytes += size.bytes;
        entry.maxSampledValueBytes = Math.max(entry.maxSampledValueBytes, size.bytes);
        entry.measuredValues += size.measuredValues;
        entry.unmeasuredValues += size.unmeasuredValues;
        if (size.unmeasuredValues) entry.incompleteSamples += 1;
      } catch { entry.incompleteSamples += 1; }
      finally { entry.sizingWallMs += performance.now() - sizingStartedAt; }
    } catch {}
  }
  function execute(action: () => unknown, metadata: Metadata) {
    if (!active()) return action();
    inFlight += 1; started += 1;
    const owned = { ...metadata, owner: operationScope.getStore() ?? "unattributed" };
    const startedAt = performance.now();
    let result: unknown;
    try { result = action(); }
    catch (error) { finish(owned, undefined, true, startedAt); throw error; }
    let asynchronous = false;
    try { asynchronous = Boolean(result && typeof (result as { then?: unknown }).then === "function"); } catch {}
    if (asynchronous) {
      return Promise.resolve(result).then(value => { finish(owned, value, false, startedAt); return value; },
        error => { finish(owned, undefined, true, startedAt); throw error; });
    }
    finish(owned, result, false, startedAt);
    return result;
  }
  return { window, roots, queries, factories, clients, driverQueries, scope, active, expired, execute, flush };
}

type Capture = ReturnType<typeof createDatabaseResponseCapture>;
let environmentCapture: { key: string; capture: Capture } | undefined;

function pacedCaptureLogger() {
  const pending: Event[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = () => {
    timer = undefined;
    for (const event of pending.splice(0, 64)) {
      try { console.info(JSON.stringify(event)); } catch {}
    }
    if (pending.length) {
      timer = setTimeout(drain, 1_000);
      timer.unref();
    }
  };
  return (event: Event) => {
    pending.push(event);
    if (!timer) {
      timer = setTimeout(drain, 0);
      timer.unref();
    }
  };
}

export function databaseResponseCaptureFromEnv(env: NodeJS.ProcessEnv = process.env): Capture | undefined {
  const key = env.PAPERCLIP_DB_RESPONSE_CAPTURE_WINDOW;
  const window = responseCaptureWindow(key);
  if (!key || !window) return;
  if (environmentCapture?.key === key) return environmentCapture.capture;
  const capture = createDatabaseResponseCapture(window, pacedCaptureLogger());
  environmentCapture = { key, capture };
  return capture;
}

export function installDatabaseResponseCapture<T extends object>(db: T, schema: Record<string, unknown>, capture = databaseResponseCaptureFromEnv()): T {
  if (!capture || capture.expired()) return db;
  const tables = new Set(Object.values(schema).filter(value => is(value, Table)).map(table => getTableName(table)));
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
  function replace(target: Record<string, unknown>, name: string, replacement: (original: Method) => Method) {
    const original = target[name];
    if (typeof original !== "function") return;
    try { target[name] = replacement(original as Method); } catch {}
  }
  function tableName(value: unknown) {
    try { if (is(value, Table)) { const name = getTableName(value); if (tables.has(name)) return name; } } catch {}
    return "other";
  }
  function query(value: unknown, metadata: Metadata) {
    if (!object(value) || capture!.queries.has(value)) return;
    capture!.queries.add(value);
    replace(value, "execute", original => function (this: unknown, ...args: unknown[]) {
      if (capture!.expired()) return Reflect.apply(original, this, args);
      return capture!.scope.run(metadata, () => Reflect.apply(original, this, args));
    });
    replace(value, "prepare", original => function (this: unknown, ...args: unknown[]) {
      const prepared = Reflect.apply(original, this, args);
      try { query(prepared, metadata); } catch {}
      return prepared;
    });
  }
  function factory(value: unknown, step: string, metadata: Metadata, from = false) {
    if (!object(value) || capture!.factories.has(value)) return;
    capture!.factories.add(value);
    replace(value, step, original => function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      try { query(result, { ...metadata, table: from ? tableName(args[0]) : metadata.table }); } catch {}
      return result;
    });
  }
  function driverQuery(value: unknown, metadata: Metadata) {
    if (!object(value) || capture!.driverQueries.has(value)) return;
    capture!.driverQueries.add(value);
    let consumed = false;
    replace(value, "then", original => function (this: unknown, ...handlers: unknown[]) {
      if (consumed || !capture!.active()) {
        consumed = true;
        return Reflect.apply(original, this, handlers);
      }
      consumed = true;
      const result = capture!.execute(() => Reflect.apply(original, this, []), metadata) as Promise<unknown>;
      return Reflect.apply(result.then, result, handlers);
    });
    for (const method of ["execute", "cursor", "forEach", "readable", "writable"]) {
      replace(value, method, original => function (this: unknown, ...args: unknown[]) {
        consumed = true;
        return Reflect.apply(original, this, args);
      });
    }
  }
  function sqlMetadata(value: unknown): Metadata {
    const scoped = capture!.scope.getStore();
    const text = typeof value === "string" ? value : "";
    let table = "other";
    for (const match of text.matchAll(/\b(?:from|update|into)\s+"([A-Za-z0-9_]+)"/gi)) {
      if (tables.has(match[1]!)) { table = match[1]!; break; }
    }
    return scoped ? { ...scoped, table: scoped.table === "other" ? table : scoped.table }
      : { operation: text.match(/^\s*(select|insert|update|delete)\b/i)?.[1]?.toLowerCase() ?? "execute",
        table, callers: capture!.active() && !operationScope.getStore() ? publicDatabaseCallers(new Error().stack) : [] };
  }
  function client(value: unknown) {
    if ((!object(value) && typeof value !== "function") || capture!.clients.has(value)) return;
    capture!.clients.add(value);
    const target = value as Record<string, unknown>;
    replace(target, "unsafe", original => function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      if (!capture!.expired()) { try { driverQuery(result, sqlMetadata(args[0])); } catch {} }
      return result;
    });
    for (const method of ["begin", "savepoint"]) {
      replace(target, method, original => function (this: unknown, ...args: unknown[]) {
        const wrapped = args.map(arg => typeof arg !== "function" ? arg : function (this: unknown, ...inner: unknown[]) {
          try { client(inner[0]); } catch {}
          return Reflect.apply(arg, this, inner);
        });
        return Reflect.apply(original, this, wrapped);
      });
    }
    replace(target, "reserve", original => function (this: unknown, ...args: unknown[]) {
      return Promise.resolve(Reflect.apply(original, this, args)).then(reserved => {
        try { client(reserved); } catch {}
        return reserved;
      });
    });
  }
  function root(value: unknown) {
    if (!object(value) || capture!.roots.has(value)) return;
    capture!.roots.add(value);
    for (const method of ["select", "selectDistinct", "selectDistinctOn", "insert", "update", "delete", "execute", "with"] as const) {
      replace(value, method, original => function (this: unknown, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args);
        if (capture!.expired()) return result;
        try {
          if (method === "with") { root(result); return result; }
          const operation = method.startsWith("select") ? "select" : method;
          const metadata = { operation, table: operation === "select" || method === "execute" ? "other" : tableName(args[0]),
            callers: capture!.active() && !operationScope.getStore() ? publicDatabaseCallers(new Error().stack) : [] };
          if (operation === "select") factory(result, "from", metadata, true);
          else if (method === "insert") factory(result, "values", metadata);
          else if (method === "update") factory(result, "set", metadata);
          else query(result, metadata);
        } catch {}
        return result;
      });
    }
    replace(value, "transaction", original => function (this: unknown, callback: unknown, ...options: unknown[]) {
      if (typeof callback !== "function" || capture!.expired()) return Reflect.apply(original, this, [callback, ...options]);
      return Reflect.apply(original, this, [function (this: unknown, ...args: unknown[]) {
        try { root(args[0]); } catch {}
        return Reflect.apply(callback, this, args);
      }, ...options]);
    });
  }
  try { client((db as Record<string, unknown>).$client); root(db); } catch {}
  return db;
}
