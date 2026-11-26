import v8 from "node:v8";
import { performance } from "node:perf_hooks";
import { PgDatabase, PgDeleteBase, PgInsertBase, PgInsertBuilder, PgSelectBase, PgSelectBuilder, PgUpdateBase, PgUpdateBuilder } from "drizzle-orm/pg-core";
import { PgRelationalQuery, RelationalQueryBuilder } from "drizzle-orm/pg-core/query-builders/query";

type Entry = {
  key: string; operation: string; callers: string[]; builds: number; executions: number;
  sqlBytes: number; buildBytes: number; buildMs: number; readBytes: number; readMs: number;
  rows: number; resultBytes: number; fields: number; calibratedBytes?: number; calibratedMs?: number; sqlPrefix?: string;
};
const CALIBRATED = 3, LOOP = 40;

const allocated = () => (v8.getHeapStatistics() as unknown as { total_allocated_bytes: number }).total_allocated_bytes;
if (typeof allocated() !== "number") {
  throw new Error(`query-cost needs a Node.js whose v8.getHeapStatistics() reports total_allocated_bytes (Node.js 26 or later); this is ${process.version}`);
}
const site = new WeakMap<object, { key: string; operation: string; callers: string[] }>();
export const entries = new Map<string, Entry>();
export const totals = { statements: 0, control: 0 };
let enabled = false;
let depth = 0;
export function setEnabled(value: boolean) { enabled = value; }

const root = process.cwd().replace(/\/server$/, "");
function callers(boundary: Function): string[] {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  Error.captureStackTrace(holder, boundary);
  Error.stackTraceLimit = limit;
  const out: string[] = [];
  for (const line of (holder.stack ?? "").split("\n").slice(1)) {
    if (line.includes("node_modules") || line.includes("query-cost/") || line.includes("node:")) continue;
    const match = line.match(/at (?:async )?(?:(\S+) \()?(?:file:\/\/)?([^()]+):(\d+):\d+\)?$/);
    if (!match) continue;
    const file = match[2]!.replace(root + "/", "");
    if (file.startsWith("packages/db/src/client") || file.includes("lazy-transaction-queries")) continue;
    out.push(`${file}:${match[3]}${match[1] ? ` ${match[1]}` : ""}`);
    if (out.length === 3) break;
  }
  return out;
}

function tag(builder: object, operation: string, boundary: Function) {
  if (!enabled || !builder || typeof builder !== "object") return;
  const stack = callers(boundary);
  site.set(builder, { key: `${operation} ${stack[0] ?? "unknown"}`, operation, callers: stack });
}

function entry(info: { key: string; operation: string; callers: string[] }): Entry {
  let value = entries.get(info.key);
  if (!value) {
    value = { ...info, builds: 0, executions: 0, sqlBytes: 0, buildBytes: 0, buildMs: 0, readBytes: 0, readMs: 0, rows: 0, resultBytes: 0, fields: 0 };
    entries.set(info.key, value);
  }
  return value;
}

function resultSize(value: unknown): { rows: number; bytes: number } {
  const rows = Array.isArray(value) ? value : (value && typeof value === "object" && Array.isArray((value as { rows?: unknown }).rows)) ? (value as { rows: unknown[] }).rows : [];
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(rows, (_k, v) => typeof v === "bigint" ? String(v) : v) ?? ""); } catch {}
  return { rows: rows.length, bytes };
}

function record(e: Entry, value: unknown) {
  const size = resultSize(value);
  const rows = Array.isArray(value) ? value : [];
  const width = e.fields || (rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0] as object).length : 0);
  e.rows += size.rows;
  e.resultBytes += size.bytes;
  e.readBytes += 40 * 1024 + width * 1024 + size.rows * width * 256 + size.bytes * 1.3;
}

function wrapPrepared(prepared: any, info: { key: string; operation: string; callers: string[] }) {
  if (!prepared || typeof prepared.execute !== "function" || prepared.__qcost) return;
  prepared.__qcost = true;
  const original = prepared.execute;
  prepared.execute = function (this: unknown, ...args: unknown[]) {
    if (!enabled) return Reflect.apply(original, this, args);
    const e = entry(info);
    e.executions += 1;
    const result = Reflect.apply(original, this, args) as Promise<unknown>;
    return Promise.resolve(result).then(value => { record(e, value); return value; });
  };
}

function wrapPrepare(proto: any, operation: string) {
  const original = proto._prepare;
  proto._prepare = function (this: object, ...args: unknown[]) {
    if (!enabled || depth > 0) return Reflect.apply(original, this, args);
    const info = site.get(this) ?? { key: `${operation} untagged`, operation, callers: [] };
    depth += 1;
    const startBytes = allocated(), startMs = performance.now();
    let prepared: any;
    try { prepared = Reflect.apply(original, this, args); }
    finally { depth -= 1; }
    let buildBytes = allocated() - startBytes, buildMs = performance.now() - startMs;
    const e = entry(info);
    if (e.builds < CALIBRATED) {
      depth += 1;
      try {
        const loopBytes = allocated(), loopMs = performance.now();
        for (let i = 0; i < LOOP; i++) Reflect.apply(original, this, args);
        buildBytes = (allocated() - loopBytes) / LOOP; buildMs = (performance.now() - loopMs) / LOOP;
      } catch {} finally { depth -= 1; }
      e.calibratedBytes = ((e.calibratedBytes ?? 0) * e.builds + buildBytes) / (e.builds + 1);
      e.calibratedMs = ((e.calibratedMs ?? 0) * e.builds + buildMs) / (e.builds + 1);
    } else { buildBytes = e.calibratedBytes ?? buildBytes; buildMs = e.calibratedMs ?? buildMs; }
    e.builds += 1;
    e.buildBytes += buildBytes;
    e.buildMs += buildMs;
    e.sqlBytes += Buffer.byteLength(prepared?.queryString ?? "");
    e.sqlPrefix ??= String(prepared?.queryString ?? "").slice(0, 200);
    e.fields = Array.isArray(prepared?.fields) ? prepared.fields.length : 0;
    wrapPrepared(prepared, info);
    return prepared;
  };
}

function wrapFactory(proto: any, method: string, operation: string) {
  const original = proto[method];
  proto[method] = function qcostFactory(this: unknown, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    tag(result, operation, qcostFactory);
    return result;
  };
}

wrapFactory(PgSelectBuilder.prototype, "from", "select");
wrapFactory(PgInsertBuilder.prototype, "values", "insert");
wrapFactory(PgInsertBuilder.prototype, "select", "insert");
wrapFactory(PgUpdateBuilder.prototype, "set", "update");
wrapFactory(PgDatabase.prototype, "delete", "delete");
wrapFactory(RelationalQueryBuilder.prototype, "findFirst", "relational");
wrapFactory(RelationalQueryBuilder.prototype, "findMany", "relational");
wrapPrepare(PgSelectBase.prototype, "select");
wrapPrepare(PgInsertBase.prototype, "insert");
wrapPrepare(PgUpdateBase.prototype, "update");
wrapPrepare(PgDeleteBase.prototype, "delete");
wrapPrepare(PgRelationalQuery.prototype, "relational");

const originalExecute = (PgDatabase.prototype as any).execute;
(PgDatabase.prototype as any).execute = function qcostExecute(this: any, query: unknown) {
  if (!enabled || depth > 0) return Reflect.apply(originalExecute, this, [query]);
  const stack = callers(qcostExecute);
  const info = { key: `execute ${stack[0] ?? "unknown"}`, operation: "execute", callers: stack };
  depth += 1;
  const startBytes = allocated(), startMs = performance.now();
  let raw: any;
  try { raw = Reflect.apply(originalExecute, this, [query]); }
  finally { depth -= 1; }
  const e = entry(info);
  let bytes = allocated() - startBytes, ms = performance.now() - startMs;
  if (e.builds < CALIBRATED) {
    depth += 1;
    try {
      const sequel = typeof query === "string" ? null : (query as { getSQL(): any }).getSQL();
      const loopBytes = allocated(), loopMs = performance.now();
      for (let i = 0; i < LOOP; i++) if (sequel) this.dialect.sqlToQuery(sequel);
      bytes = (allocated() - loopBytes) / LOOP; ms = (performance.now() - loopMs) / LOOP;
    } catch {} finally { depth -= 1; }
    e.calibratedBytes = ((e.calibratedBytes ?? 0) * e.builds + bytes) / (e.builds + 1);
    e.calibratedMs = ((e.calibratedMs ?? 0) * e.builds + ms) / (e.builds + 1);
  } else { bytes = e.calibratedBytes ?? bytes; ms = e.calibratedMs ?? ms; }
  e.builds += 1;
  e.buildBytes += bytes;
  e.buildMs += ms;
  e.sqlBytes += Buffer.byteLength(raw?.query?.sql ?? "");
  e.sqlPrefix ??= String(raw?.query?.sql ?? "").slice(0, 200);
  const execute = raw.execute;
  raw.execute = function (this: unknown, ...args: unknown[]) {
    if (enabled) e.executions += 1;
    return Promise.resolve(Reflect.apply(execute, this, args)).then(value => { if (enabled) record(e, value); return value; });
  };
  return raw;
};

export function countStatements(db: { $client: { options: { debug?: unknown } } }) {
  db.$client.options.debug = (_connection: number, text: string) => {
    totals.statements += 1;
    if (/^\s*(begin|commit|rollback|savepoint|release)\b/i.test(text)) totals.control += 1;
  };
}

export function snapshot() {
  return { statements: totals.statements, control: totals.control, allocated: allocated(), at: performance.now(),
    entries: new Map([...entries].map(([key, value]) => [key, { ...value }])) };
}

export function diff(before: ReturnType<typeof snapshot>) {
  const rows: Entry[] = [];
  for (const [key, value] of entries) {
    const prior = before.entries.get(key);
    const d = { ...value } as Entry;
    if (prior) for (const field of ["builds", "executions", "sqlBytes", "buildBytes", "buildMs", "readBytes", "readMs", "rows", "resultBytes"] as const) d[field] -= prior[field];
    if (d.builds || d.executions) rows.push(d);
  }
  rows.sort((a, b) => (b.buildBytes + b.readBytes) - (a.buildBytes + a.readBytes));
  return { statements: totals.statements - before.statements, control: totals.control - before.control,
    allocated: allocated() - before.allocated, wallMs: performance.now() - before.at, rows };
}

export function format(label: string, units: number, result: ReturnType<typeof diff>, top = Number(process.env.TOP ?? 25)) {
  const kb = (n: number) => (n / 1024 / units).toFixed(1);
  const lines = [`## ${label} (per unit, ${units} units)`,
    `statements ${(result.statements / units).toFixed(1)} (control ${(result.control / units).toFixed(1)}), total allocated ${kb(result.allocated)} KB, built ${kb(result.rows.reduce((s, r) => s + r.buildBytes, 0))} KB, read ${kb(result.rows.reduce((s, r) => s + r.readBytes, 0))} KB, wall ${(result.wallMs / units).toFixed(1)} ms`,
    "| family | calls | builds | SQL B/build | built KB/call | read KB/call (model) | rows/call | result KB/call | fields | build ms/call |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of result.rows.slice(0, top)) {
    const calls = Math.max(row.executions, row.builds);
    lines.push(`| ${row.key}${row.callers[1] ? ` <- ${row.callers.slice(1).join(" <- ")}` : ""} | ${(calls / units).toFixed(2)} | ${(row.builds / units).toFixed(2)} | ${row.builds ? Math.round(row.sqlBytes / row.builds) : 0} | ${(row.buildBytes / 1024 / Math.max(1, row.builds)).toFixed(1)} | ${(row.readBytes / 1024 / Math.max(1, row.executions)).toFixed(1)} | ${(row.rows / Math.max(1, row.executions)).toFixed(1)} | ${(row.resultBytes / 1024 / Math.max(1, row.executions)).toFixed(1)} | ${row.fields} | ${(row.buildMs / Math.max(1, row.builds)).toFixed(3)} |`);
  }
  if (process.env.SQL_PREFIX) for (const row of result.rows.slice(0, top)) lines.push(`- ${row.key}: \`${row.sqlPrefix}\``);
  return lines.join("\n");
}
