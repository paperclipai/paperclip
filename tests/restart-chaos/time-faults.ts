/**
 * Time faults (TM1–TM3): the fourth fault family, next to restarts (K*), storage
 * (ST*) and provider messages (PV*). Every other wave is minutes long on a fresh
 * instance, so nothing time-bound ever expires. These faults make deadlines lapse
 * during a run or across a restart, without changing product code:
 *
 * - TM1 freeze: SIGSTOP the server process alone (not its runners, not Postgres)
 *   for 95–150 s, then SIGCONT. Longer than the controller-instance lease (90 s),
 *   the execution-control deadline (60 s) and the legacy run lease (60 s), so the
 *   server's own leases lapse while it believes it is healthy (a GC pause), while
 *   the runner keeps working and calling a server that does not answer.
 * - TM2 sleep: SIGSTOP the server and every process under it (runners, providers),
 *   shift every timestamp in the wave's database back by the age (default 26 h),
 *   then SIGCONT. A laptop-sleep stand-in: the database says the age has passed.
 *   The processes' monotonic clocks keep running while they are stopped (only a
 *   real system suspend stops them), so in-process deadlines shorter than the
 *   20–45 s pause also lapse, as in a long process stall.
 * - TM3 aged outage: SIGKILL the server tree (as K1), shift every timestamp back
 *   by the age while it is down, then restart. The replacement must reconcile
 *   runs, leases, wakes and waits that look hours old. With `--workloads G1
 *   --triggers approval` this is the aged wait: an approval pending for a day
 *   across a restart (the class of #20340).
 *
 * Aging shifts every `timestamp` column of every table in the `public` schema by
 * the same interval, so the database is exactly what it would be had everything
 * happened the age earlier. Triggers are disabled for the shift (replica role)
 * so derived columns are not rewritten. The rows of the time-bound tables are
 * recorded with their values before the shift in `time-faults/<faultId>.json`.
 *
 * Grading reads run times through `TimeShiftedApi`, which adds the age back to
 * any timestamp the shift moved, so R4 overlaps and speed budgets are judged on
 * real time. The product itself sees only the aged values.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDb } from "../../packages/db/src/index.js";
import { ChaosApi } from "./api.js";
import type { TimeFaultKind } from "./time-faults-config.js";

export { DEFAULT_TIME_AGE_MS, TIME_FAULT_KINDS, TIME_FREEZE_HOLD_RANGE_MS, isTimeFault, timeFaultHoldMs, type TimeFaultKind } from "./time-faults-config.js";

/** Tables whose rows carry the deadlines a run depends on; their rows are recorded in the evidence. */
export const TIME_BOUND_TABLES = [
  "heartbeat_runs", "native_run_finalizations", "controller_instances", "agent_wakeup_requests", "environment_leases",
  "execution_workspace_runtime_leases", "workspace_operations", "approvals", "decisions", "issue_thread_interactions",
  "budget_resume_claims", "routine_triggers", "issue_recovery_actions",
] as const;
const RECORDED_ROWS_PER_TABLE = 200;

export interface AgingShift {
  faultId: string;
  ageMs: number;
  /** Harness clock when the shift committed. */
  appliedAt: number;
  /**
   * Wave start on the harness clock. Every time the wave wrote is at or after it, and the age is
   * longer than the wave has run, so a value this shift moved lands before it, unless the value was
   * a deadline more than `ageMs - (appliedAt - waveStartedAt)` in the future.
   */
  waveStartedAt: number;
}

export interface AgedTable { table: string; columns: string[]; rows: number }

export interface AgingResult extends AgingShift {
  startedAt: number;
  tables: AgedTable[];
  totalRows: number;
  /** False when the database role could not disable triggers (the shift then ran with them on). */
  triggersDisabled: boolean;
  /** TM2: lock waits on a frozen server's connection that needed a brief thaw before retrying. */
  lockRetries: number;
  evidencePath: string;
}

export interface TimeFaultRecord {
  kind: TimeFaultKind;
  /** TM1/TM2: the processes frozen (server first). */
  frozenPids?: number[];
  frozenAt?: number;
  thawedAt?: number;
  aging?: AgingResult;
  /** The frozen server exited on its own after SIGCONT (for example a lost-lease self-fence); a replacement was started. */
  serverExitedAfterThaw?: { code: number | null; signal: string | null };
  /** The exited server's process tree could not be shown stopped; the fault fails as a harness error. */
  cleanupError?: string;
}

/**
 * TM1/TM2 sequence, with every side effect injected (supervisor.ts supplies them):
 * freeze, optionally age while frozen, hold, always thaw, then wait for the same
 * server. A server that exited on its own after the thaw is cleaned up and replaced;
 * a cleanup that cannot prove the old tree stopped is recorded, not swallowed.
 */
export async function runFreezeFault(input: {
  kind: "TM1" | "TM2"; rootPid: number; holdMs: number; record: TimeFaultRecord;
  freezer: Pick<ProcessFreezer, "freeze" | "thaw">;
  age?: (onLockTimeout: () => Promise<void>) => Promise<AgingResult>;
  cancelled: () => boolean;
  onFrozen?: (pids: number[]) => void; onThawed?: (frozenMs: number) => void;
  waitHealthy: () => Promise<number>;
  exitStatus: () => { code: number | null; signal: string | null } | null;
  replaceExited: () => Promise<void>;
  startReplacement: () => Promise<number>;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
}): Promise<{ stoppedAt: number; restartedAt: number; healthyAt: number }> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const { record } = input;
  const tree = input.kind === "TM2";
  let stoppedAt = now();
  try {
    record.frozenPids = input.freezer.freeze(input.rootPid, tree);
    stoppedAt = record.frozenAt = now();
    input.onFrozen?.(record.frozenPids);
    if (input.age) {
      record.aging = await input.age(async () => {
        // A frozen connection holds a lock the shift needs: let the tree run briefly, then freeze it again.
        input.freezer.thaw();
        await sleep(2_000);
        record.frozenPids = [...new Set([...(record.frozenPids ?? []), ...input.freezer.freeze(input.rootPid, tree)])];
      });
    }
    while (now() - stoppedAt < input.holdMs) {
      if (input.cancelled()) throw new Error("Harness shutdown interrupted the freeze");
      await sleep(Math.min(1_000, input.holdMs - (now() - stoppedAt)));
    }
  } finally {
    input.freezer.thaw();
    record.thawedAt = now();
    input.onThawed?.(record.thawedAt - (record.frozenAt ?? record.thawedAt));
  }
  const restartedAt = record.thawedAt;
  try {
    return { stoppedAt, restartedAt, healthyAt: await input.waitHealthy() };
  } catch (error) {
    const exit = input.exitStatus();
    if (!exit) throw error;
    record.serverExitedAfterThaw = exit;
    try {
      await input.replaceExited();
    } catch (cleanup) {
      // An old runner may still be alive and writing: fail the fault rather than start a second server beside it.
      record.cleanupError = cleanup instanceof Error ? cleanup.message : String(cleanup);
      throw new Error(`Exited server's process tree could not be shown stopped: ${record.cleanupError}`);
    }
    return { stoppedAt, restartedAt, healthyAt: await input.startReplacement() };
  }
}

export interface ProcessRow { pid: number; ppid: number; command: string }

export function parseProcessTable(output: string): ProcessRow[] {
  return output.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() }] : [];
  });
}

/**
 * Every process under `rootPid`, parents before children. Postgres never runs
 * under the server (it is wrapper-owned, beside it), and anything that looks like
 * Postgres is excluded anyway: freezing the database is a different fault.
 */
export function descendantPids(rootPid: number, table: readonly ProcessRow[]): number[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const out: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length) {
    const row = queue.shift()!;
    if (/(^|\/)postgres(\s|$)|postmaster/.test(row.command)) continue;
    out.push(row.pid);
    queue.push(...(children.get(row.pid) ?? []));
  }
  return out;
}

function readProcessTable(): ProcessRow[] {
  return parseProcessTable(execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

const frozenEverywhere = new Set<number>();
let exitHookInstalled = false;

/**
 * SIGSTOP/SIGCONT for processes this wave started. Whatever happens to the
 * harness, a frozen process is continued on exit, so it can still be stopped.
 */
export class ProcessFreezer {
  private frozen: number[] = [];

  constructor(private readonly signal: (pid: number, signal: NodeJS.Signals) => void = (pid, sig) => process.kill(pid, sig),
    private readonly table: () => ProcessRow[] = readProcessTable) {
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.on("exit", () => { for (const pid of frozenEverywhere) try { process.kill(pid, "SIGCONT"); } catch { /* gone */ } });
    }
  }

  get pids(): readonly number[] { return this.frozen; }

  /** Freezes the root first (it then cannot spawn), then its tree, rescanning once for late children. */
  freeze(rootPid: number, tree: boolean): number[] {
    this.stop(rootPid);
    if (tree) {
      for (let pass = 0; pass < 2; pass += 1) {
        for (const pid of descendantPids(rootPid, this.table())) if (!this.frozen.includes(pid)) this.stop(pid);
      }
    }
    return [...this.frozen];
  }

  thaw(): void {
    for (const pid of this.frozen) {
      try { this.signal(pid, "SIGCONT"); } catch { /* exited meanwhile */ }
      frozenEverywhere.delete(pid);
    }
    this.frozen = [];
  }

  private stop(pid: number) {
    try { this.signal(pid, "SIGSTOP"); } catch { return; }
    this.frozen.push(pid);
    frozenEverywhere.add(pid);
  }
}

/** The wave's database URL from the instance config the supervisor wrote. */
export function databaseUrlFromConfig(configPath: string): string {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { database?: { connectionString?: string } };
  const url = config.database?.connectionString;
  if (!url) throw new Error("Time fault: the instance config has no database connection string");
  return url;
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, "\"\"")}"`;

export type AgingColumn = { table: string; column: string; kind: "timestamp" | "json" };

/**
 * A session function (pg_temp) that shifts every time inside a JSON value, so a
 * copy of a time (a snapshot, a receipt, an event payload) still equals the
 * column it was copied from:
 * - an ISO datetime string keeps its exact format, separator and offset;
 * - a whole number in the epoch-millisecond window [lo, hi] (the wave's own times) moves by the age.
 * The age is whole seconds, so fractional digits never change. A process start
 * (`processStartedAt`, any spelling) is identity, not a time: see `isProcessIdentityTime`.
 */
export const SHIFT_JSON_FUNCTION = [
  "create or replace function pg_temp.paperclip_shift_json(v jsonb, age_ms bigint, lo bigint, hi bigint)",
  "returns jsonb language plpgsql immutable as $fn$",
  "declare t text; m text[]; r jsonb; shifted timestamp;",
  "begin",
  "  case jsonb_typeof(v)",
  "  when 'object' then",
  "    select coalesce(jsonb_object_agg(e.key, case when replace(lower(e.key), '_', '') like '%processstartedat%' then e.value",
  "      else pg_temp.paperclip_shift_json(e.value, age_ms, lo, hi) end), '{}'::jsonb) into r from jsonb_each(v) e;",
  "    return r;",
  "  when 'array' then",
  "    select coalesce(jsonb_agg(pg_temp.paperclip_shift_json(e.value, age_ms, lo, hi) order by e.ord), '[]'::jsonb) into r",
  "      from jsonb_array_elements(v) with ordinality e(value, ord);",
  "    return r;",
  "  when 'string' then",
  "    t := v #>> '{}';",
  "    m := regexp_match(t, '^([0-9]{4}-[0-9]{2}-[0-9]{2})([T ])([0-9]{2}:[0-9]{2}:[0-9]{2})([.][0-9]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$');",
  "    if m is null then return v; end if;",
  "    begin",
  "      shifted := (m[1] || ' ' || m[3])::timestamp - make_interval(secs => age_ms / 1000);",
  "    exception when others then return v;",
  "    end;",
  "    return to_jsonb(to_char(shifted, 'YYYY-MM-DD') || m[2] || to_char(shifted, 'HH24:MI:SS') || coalesce(m[4], '') || coalesce(m[5], ''));",
  "  when 'number' then",
  "    t := v #>> '{}';",
  "    if t ~ '^[0-9]{12,14}$' and t::numeric between lo and hi then return to_jsonb(t::bigint - age_ms); end if;",
  "    return v;",
  "  else",
  "    return v;",
  "  end case;",
  "end $fn$",
].join("\n");

/**
 * A process start time is part of a process's identity (pid + start), read from
 * the OS and compared with the stamp an owner saved. A real sleep never changes
 * it, so aging it would make every live owner look like a different process: a
 * harness artifact, not a deadline that lapsed. Columns and JSON keys named for
 * a process start (`process_started_at`, `controller_process_started_at`,
 * `processStartedAt`, ...) keep their value.
 */
export function isProcessIdentityTime(name: string): boolean {
  return name.toLowerCase().replaceAll("_", "").includes("processstartedat");
}

/** One UPDATE per table, shifting all of its timestamp and JSON columns at once (process start identity excepted). */
export function agingStatements(columns: ReadonlyArray<AgingColumn>, ageMs: number,
  epochWindow: { lo: number; hi: number }): Array<{ table: string; columns: string[]; sql: string }> {
  if (!Number.isSafeInteger(ageMs) || ageMs <= 0 || ageMs % 1000 !== 0) throw new Error("Aging needs a positive whole number of seconds");
  const byTable = new Map<string, AgingColumn[]>();
  for (const column of columns) if (!isProcessIdentityTime(column.column)) byTable.set(column.table, [...(byTable.get(column.table) ?? []), column]);
  const shift = (column: AgingColumn) => column.kind === "timestamp"
    ? `${quote(column.column)} - interval '${ageMs} milliseconds'`
    : `pg_temp.paperclip_shift_json(${quote(column.column)}, ${ageMs}, ${Math.trunc(epochWindow.lo)}, ${Math.trunc(epochWindow.hi)})`;
  return [...byTable.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([table, cols]) => {
    const present = cols.map(col => `${quote(col.column)} is not null`).join(" or ");
    return { table, columns: cols.map(col => col.column),
      sql: `update public.${quote(table)} set ${cols.map(col => `${quote(col.column)} = ${shift(col)}`).join(", ")} where ${present}` };
  });
}

const LOCK_NOT_AVAILABLE = "55P03";
const MAX_LOCK_ATTEMPTS = 6;

/**
 * Shifts every timestamp in the wave's database back by `ageMs` in one
 * transaction. `onLockTimeout` runs between attempts when a lock is held (TM2:
 * a frozen server's open transaction); it may thaw and refreeze the server.
 */
export async function ageWaveDatabase(input: { connectionString: string; faultId: string; ageMs: number; evidenceDir: string;
  /** Wave start on the harness clock: the shift must move every row the wave wrote below anything it did not move. */
  waveStartedAt: number;
  /** Total age of earlier shifts in this wave: their epoch milliseconds already sit that much below the window. */
  priorAgeMs?: number;
  onLockTimeout?: () => Promise<void>; now?: () => number }): Promise<AgingResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  if (startedAt - input.waveStartedAt >= input.ageMs - 60_000) {
    throw new Error(`Time fault ${input.faultId}: the wave has run ${Math.round((startedAt - input.waveStartedAt) / 60_000)} min, `
      + "too close to the age; raise --time-age-hours so shifted and unshifted times cannot overlap");
  }
  const db = createDb(input.connectionString);
  const sql = db.$client;
  try {
    const columns = await sql.unsafe(`select c.table_name as "table", c.column_name as "column",
        case when c.data_type = 'jsonb' then 'json' else 'timestamp' end as kind
      from information_schema.columns c join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.data_type in ('timestamp with time zone', 'timestamp without time zone', 'jsonb')
      order by c.table_name, c.ordinal_position`) as unknown as AgingColumn[];
    const statements = agingStatements(columns, input.ageMs, epochWindow(input.waveStartedAt, input.priorAgeMs ?? 0, startedAt));
    const identityColumns = await sql.unsafe(`select table_name as "table", column_name as "column" from information_schema.columns
      where table_schema = 'public' and table_name = any($1) and column_name in ('id', 'boot_id', 'run_id', 'issue_id', 'status', 'phase', 'state')
      order by table_name, ordinal_position`, [[...TIME_BOUND_TABLES]]) as unknown as Array<{ table: string; column: string }>;
    const [role] = await sql.unsafe("select rolsuper from pg_roles where rolname = current_user") as unknown as Array<{ rolsuper: boolean }>;
    const triggersDisabled = role?.rolsuper === true;
    const recorded = new Set<string>(TIME_BOUND_TABLES);
    let lockRetries = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = await sql.begin(async tx => {
          await tx.unsafe("set local lock_timeout = '3s'");
          if (triggersDisabled) await tx.unsafe("set local session_replication_role = replica");
          await tx.unsafe(SHIFT_JSON_FUNCTION);
          const before: Record<string, unknown[]> = {};
          for (const statement of statements) {
            if (!recorded.has(statement.table)) continue;
            // Identity, state and times only: payload columns can carry run output.
            const keys = identityColumns.filter(key => key.table === statement.table).map(key => key.column);
            const times = columns.filter(column => column.table === statement.table && column.kind === "timestamp"
              && !isProcessIdentityTime(column.column)).map(column => column.column);
            const select = [...keys, ...times].map(quote).join(", ");
            const order = times.includes("created_at") ? " order by created_at desc" : "";
            before[statement.table] = await tx.unsafe(`select ${select} from public.${quote(statement.table)}${order} limit ${RECORDED_ROWS_PER_TABLE}`) as unknown as unknown[];
          }
          const tables: AgedTable[] = [];
          for (const statement of statements) {
            const result = await tx.unsafe(statement.sql);
            tables.push({ table: statement.table, columns: statement.columns, rows: result.count ?? 0 });
          }
          return { before, tables };
        });
        const appliedAt = now();
        const tables = outcome.tables.filter(table => table.rows > 0);
        const evidencePath = path.join(input.evidenceDir, `${input.faultId}.json`);
        await mkdir(input.evidenceDir, { recursive: true, mode: 0o700 });
        await writeFile(evidencePath, `${JSON.stringify({ faultId: input.faultId, ageMs: input.ageMs, startedAt, appliedAt,
          note: "Rows of the time-bound tables as they were before the shift; after the shift every timestamp shown is ageMs earlier. Process start identity is not aged and not shown.",
          tables, rowsBefore: outcome.before }, null, 2)}\n`, { mode: 0o600 });
        return { faultId: input.faultId, ageMs: input.ageMs, appliedAt, waveStartedAt: input.waveStartedAt, startedAt, tables,
          totalRows: tables.reduce((sum, table) => sum + table.rows, 0), triggersDisabled, lockRetries, evidencePath };
      } catch (error) {
        if ((error as { code?: string }).code !== LOCK_NOT_AVAILABLE || attempt >= MAX_LOCK_ATTEMPTS) throw error;
        lockRetries += 1;
        await input.onLockTimeout?.();
      }
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

const DAY_MS = 86_400_000;

/**
 * Epoch milliseconds the wave itself could have written: from a day before it started (less every
 * earlier shift, so a value aged once is aged again) to a week ahead.
 */
export function epochWindow(waveStartedAt: number, priorAgeMs: number, now: number): { lo: number; hi: number } {
  return { lo: waveStartedAt - DAY_MS - priorAgeMs, hi: now + 7 * DAY_MS };
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * The real time of a database time the shifts moved; other values are returned unchanged. Latest
 * shift first. A moved value lands before the wave started (the age outlasts the wave); nothing the
 * wave wrote is earlier. A deadline more than the age minus the wave's run time ahead stays aged.
 */
export function unshiftMs(value: number, shifts: readonly AgingShift[]): number {
  let real = value;
  for (const shift of [...shifts].sort((a, b) => b.appliedAt - a.appliedAt)) {
    if (real < shift.waveStartedAt) real += shift.ageMs;
  }
  return real;
}

/** Whole numbers inside JSON that aging treats as epoch milliseconds, read back the same way. */
function shiftedEpochMs(node: number, shifts: readonly AgingShift[]): boolean {
  if (!Number.isSafeInteger(node) || node < 1e11 || node >= 1e14) return false;
  const total = shifts.reduce((sum, shift) => sum + shift.ageMs, 0);
  const earliest = Math.min(...shifts.map(shift => shift.waveStartedAt));
  return node >= earliest - DAY_MS - total;
}

/** Copies `value`, with every ISO timestamp and epoch-millisecond number the shifts moved put back at its real time. */
export function unshiftJson<T>(value: T, shifts: readonly AgingShift[]): T {
  if (!shifts.length) return value;
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (!ISO_TIMESTAMP.test(node)) return node;
      const ms = Date.parse(node);
      if (!Number.isFinite(ms)) return node;
      const real = unshiftMs(ms, shifts);
      return real === ms ? node : new Date(real).toISOString();
    }
    if (typeof node === "number") return shiftedEpochMs(node, shifts) ? unshiftMs(node, shifts) : node;
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node)
      .map(([key, child]) => [key, isProcessIdentityTime(key) ? child : visit(child)]));
    return node;
  };
  return visit(value) as T;
}

/**
 * The board API as the grader should read it in a wave with aged rows: run and
 * event times come back at their real times. Writes are unchanged.
 */
export class TimeShiftedApi extends ChaosApi {
  constructor(baseUrl: string, readonly shifts: AgingShift[]) { super(baseUrl); }

  override get<T>(route: string, timeoutMs?: number): Promise<T> {
    return super.get<T>(route, timeoutMs).then(value => unshiftJson(value, this.shifts));
  }
}
