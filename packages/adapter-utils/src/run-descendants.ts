import fs from "node:fs";
import fsp from "node:fs/promises";

/**
 * Finds and stops processes that a local agent run left behind.
 *
 * A local adapter starts its CLI in a new process group and run teardown
 * signals that group. Tools inside the CLI can leave it: Claude Code runs each
 * Bash tool call in a new session (setsid), and `nohup`, `setsid` or a double
 * fork move a server out of the group and reparent it to init. A group signal
 * then never reaches it and it outlives the run.
 *
 * A process belongs to a run when any of these holds:
 * - Marker: its initial environment carries `PAPERCLIP_RUN_ID=<run id>`.
 *   Every local run exports it to its CLI and descendants inherit it, whatever
 *   group or session they move to. The run id is a per-run UUID.
 * - Recorded lineage: a {@link RunProcessLineage} saw it as a run process.
 *   While a run is live the caller samples the process table; any child of a
 *   run process is recorded by PID plus start time. A recorded process stays
 *   owned after it clears its environment (`env -i`), execs, or is reparented.
 * - Parent: its parent is a run process.
 * - Session or group: it is in a session or process group whose leader was a
 *   run process. A background server keeps its session and group after its
 *   starter exits and it is reparented, even with a cleared environment.
 *
 * Safety rules:
 * - Linux only. Elsewhere the functions find nothing and the caller keeps its
 *   existing process-group teardown.
 * - Only processes owned by the current user are considered.
 * - The current process and its ancestors are never matched, and their
 *   sessions and groups are never used to match others, so a Paperclip server
 *   started inside an agent run does not stop itself.
 * - A process is identified by PID plus kernel start time. The start time is
 *   read again before each signal, so a reused PID is never signalled.
 * - A session or group of a dead leader matches only members that started
 *   before the leader was seen gone. Linux does not reuse a PID number while
 *   any process still uses it as a session or group id, so this excludes a
 *   later session that reused the number.
 * - Callers can exclude PIDs and process groups that another owner tracks
 *   (for example a server-managed runtime service).
 *
 * Known limit: lineage is sampled, not event-driven. A process that clears
 * its environment, and whose run-owned parent and session or group leader all
 * exit before the next sample, is not matched. A kernel containment (a
 * delegated cgroup) is needed to close that gap.
 */

export const RUN_ID_ENV_MARKER = "PAPERCLIP_RUN_ID";

export interface RunProcessIdentity {
  pid: number;
  /** Kernel start time in clock ticks since boot (`/proc/<pid>/stat` field 22). */
  startTime: string;
}

/** A recorded run process, as persisted in a lineage snapshot. */
export interface RunLineageEntry extends RunProcessIdentity {
  /** The process led its session or its process group when it was seen. */
  leader?: boolean;
  /** Clock ticks since boot when the process was first seen gone. */
  goneAtTicks?: number;
}

export interface RunLineageSnapshot {
  version: 1;
  runId: string;
  /** Linux boot id. PIDs and start times repeat after a reboot. */
  bootId: string | null;
  entries: RunLineageEntry[];
}

export interface RunDescendantScanOptions {
  /** Test seam: alternative procfs root. Defaults to `/proc`. */
  procRoot?: string;
  /** PIDs that must never be matched, in addition to this process and its ancestors. */
  excludePids?: Iterable<number>;
  /** Process groups that must never be matched (for example registered services). */
  excludeProcessGroupIds?: Iterable<number>;
}

export interface RunDescendantTerminateOptions extends RunDescendantScanOptions {
  /** Time between the first signal and SIGKILL. Defaults to 5000 ms. */
  graceMs?: number;
  /** First signal. Defaults to SIGTERM. */
  signal?: NodeJS.Signals;
  /** Poll interval while waiting. Defaults to 100 ms. */
  pollMs?: number;
  /** Lineage recorded while the run was live. Updated in place. */
  lineage?: RunProcessLineage;
}

export interface RunDescendantTerminateResult {
  /** Every run process found during teardown, including ones that appeared during the grace period. */
  found: RunProcessIdentity[];
  /** Processes that received SIGKILL because they did not stop in the grace period. */
  forceKilled: RunProcessIdentity[];
  /** Processes still alive after SIGKILL and a short wait. */
  survivors: RunProcessIdentity[];
}

interface ProcEntry extends RunProcessIdentity {
  ppid: number;
  pgid: number;
  sid: number;
}

/** A same-user process table read once from procfs. */
export interface RunProcessTable {
  entries: Map<number, ProcEntry>;
  /** Clock ticks since boot when the table was read. */
  nowTicks: number;
  procRoot: string;
  /**
   * Order in which table reads started. A lineage does not let an older table
   * forget processes that a newer table already recorded.
   */
  seq?: number;
}

const MAX_RUN_ID_LENGTH = 256;
const KILL_SETTLE_MS = 1_000;
// Linux reports /proc start times in USER_HZ, which is 100 on every
// architecture's userspace ABI.
const USER_HZ = 100;

function isSupported() {
  return process.platform === "linux" && typeof process.getuid === "function";
}

function isValidRunId(runId: string) {
  return (
    typeof runId === "string" &&
    runId.length > 0 &&
    runId.length <= MAX_RUN_ID_LENGTH &&
    !runId.includes("\0")
  );
}

interface ProcStat {
  ppid: number;
  pgid: number;
  sid: number;
  state: string;
  startTime: string;
}

function parseStat(raw: string): ProcStat | null {
  // The command name (field 2) can contain spaces and parentheses.
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state); field N is fields[N - 3].
  const state = fields[0];
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  const pgid = Number.parseInt(fields[2] ?? "", 10);
  const sid = Number.parseInt(fields[3] ?? "", 10);
  const startTime = fields[19];
  if (
    !state ||
    !Number.isInteger(ppid) ||
    !Number.isInteger(pgid) ||
    !Number.isInteger(sid) ||
    !startTime ||
    !/^\d+$/.test(startTime)
  ) {
    return null;
  }
  return { ppid, pgid, sid, state, startTime };
}

function readStat(procRoot: string, pid: number): ProcStat | null {
  try {
    return parseStat(fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

async function readStatAsync(procRoot: string, pid: number): Promise<ProcStat | null> {
  try {
    return parseStat(await fsp.readFile(`${procRoot}/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/** The Linux boot id, or null when it cannot be read. */
export function readBootId(opts: Pick<RunDescendantScanOptions, "procRoot"> = {}) {
  try {
    const id = fs.readFileSync(`${opts.procRoot ?? "/proc"}/sys/kernel/random/boot_id`, "utf8").trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function isGoneState(state: string) {
  return state === "Z" || state === "X" || state === "x";
}

function readNowTicks(procRoot: string) {
  try {
    const seconds = Number.parseFloat(fs.readFileSync(`${procRoot}/uptime`, "utf8").split(/\s+/)[0] ?? "");
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * USER_HZ);
  } catch {
    // Fall through.
  }
  return Number.MAX_SAFE_INTEGER;
}

function protectedPids(procRoot: string) {
  const pids = new Set<number>();
  let pid = process.pid;
  // Bounded walk: a PID chain cannot be longer than the process table.
  for (let depth = 0; depth < 4096 && pid > 0 && !pids.has(pid); depth += 1) {
    pids.add(pid);
    const stat = readStat(procRoot, pid);
    if (!stat) break;
    pid = stat.ppid;
  }
  return pids;
}

function hasRunMarker(procRoot: string, pid: number, needle: Buffer) {
  let environ: Buffer;
  try {
    environ = fs.readFileSync(`${procRoot}/${pid}/environ`);
  } catch {
    return false;
  }
  return environHasNeedle(environ, needle);
}

function environHasNeedle(environ: Buffer, needle: Buffer) {
  if (environ.length === 0) return false;
  // Entries are NUL-terminated; prefix a NUL so the first entry matches too.
  const haystack = Buffer.concat([Buffer.from([0]), environ, Buffer.from([0])]);
  return haystack.indexOf(needle) >= 0;
}

function markerNeedle(runId: string) {
  return Buffer.from(`\0${RUN_ID_ENV_MARKER}=${runId}\0`);
}

let tableReadSeq = 0;

function identityKey(identity: RunProcessIdentity) {
  return `${identity.pid}:${identity.startTime}`;
}

/** Reads every live process of the current user. Empty on unsupported platforms. */
export function readRunProcessTable(opts: Pick<RunDescendantScanOptions, "procRoot"> = {}): RunProcessTable {
  const procRoot = opts.procRoot ?? "/proc";
  const entries = new Map<number, ProcEntry>();
  const table = { entries, nowTicks: readNowTicks(procRoot), procRoot, seq: ++tableReadSeq };
  if (!isSupported()) return table;
  const uid = process.getuid!();
  let names: string[];
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return table;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    if (!(pid > 1)) continue;
    try {
      if (fs.statSync(`${procRoot}/${name}`).uid !== uid) continue;
    } catch {
      continue;
    }
    const stat = readStat(procRoot, pid);
    if (!stat || isGoneState(stat.state)) continue;
    entries.set(pid, { pid, startTime: stat.startTime, ppid: stat.ppid, pgid: stat.pgid, sid: stat.sid });
  }
  return table;
}

// Bounded batch size for the asynchronous scan: each batch's file reads run
// on the libuv thread pool and the main thread only parses the results.
const ASYNC_SCAN_BATCH = 64;

/**
 * Reads every live process of the current user without blocking the event
 * loop on procfs: directory listing, ownership and stat reads are
 * asynchronous and done in bounded batches.
 */
export async function readRunProcessTableAsync(
  opts: Pick<RunDescendantScanOptions, "procRoot"> = {},
): Promise<RunProcessTable> {
  const procRoot = opts.procRoot ?? "/proc";
  const entries = new Map<number, ProcEntry>();
  const seq = ++tableReadSeq;
  let nowTicks = Number.MAX_SAFE_INTEGER;
  try {
    const seconds = Number.parseFloat((await fsp.readFile(`${procRoot}/uptime`, "utf8")).split(/\s+/)[0] ?? "");
    if (Number.isFinite(seconds) && seconds >= 0) nowTicks = Math.ceil(seconds * USER_HZ);
  } catch {
    // Keep the open-ended bound.
  }
  const table = { entries, nowTicks, procRoot, seq };
  if (!isSupported()) return table;
  const uid = process.getuid!();
  let names: string[];
  try {
    names = await fsp.readdir(procRoot);
  } catch {
    return table;
  }
  const pids = names.filter((name) => /^\d+$/.test(name)).map((name) => Number.parseInt(name, 10)).filter((pid) => pid > 1);
  for (let index = 0; index < pids.length; index += ASYNC_SCAN_BATCH) {
    await Promise.all(
      pids.slice(index, index + ASYNC_SCAN_BATCH).map(async (pid) => {
        try {
          if ((await fsp.stat(`${procRoot}/${pid}`)).uid !== uid) return;
        } catch {
          return;
        }
        const stat = await readStatAsync(procRoot, pid);
        if (!stat || isGoneState(stat.state)) return;
        entries.set(pid, { pid, startTime: stat.startTime, ppid: stat.ppid, pgid: stat.pgid, sid: stat.sid });
      }),
    );
  }
  return table;
}

/**
 * The set of processes recorded for one run. Call {@link sample} while the
 * run is live so that processes are recorded before they can lose the
 * marker or their parent. The state can be saved with {@link toSnapshot} and
 * restored with {@link fromSnapshot}, so a cancel after a server restart still
 * knows what the run started.
 */
export class RunProcessLineage {
  readonly runId: string;
  private readonly needle: Buffer;
  private readonly recorded = new Map<string, RunLineageEntry>();
  // Marker results by identity. The initial environment is fixed until exec,
  // and an exec'd process that was already recorded stays recorded.
  private markerCache = new Map<string, boolean>();
  private changed = false;
  private lastTableSeq = 0;

  constructor(runId: string, entries: Iterable<RunLineageEntry> = []) {
    this.runId = runId;
    this.needle = markerNeedle(runId);
    for (const entry of entries) {
      if (!Number.isInteger(entry.pid) || entry.pid <= 1 || !/^\d+$/.test(entry.startTime)) continue;
      this.recorded.set(identityKey(entry), {
        pid: entry.pid,
        startTime: entry.startTime,
        ...(entry.leader ? { leader: true } : {}),
        ...(typeof entry.goneAtTicks === "number" ? { goneAtTicks: entry.goneAtTicks } : {}),
      });
    }
  }

  /**
   * Restores a saved lineage. Returns null for a malformed snapshot or one
   * saved during another boot: PIDs and start times repeat after a reboot.
   */
  static fromSnapshot(snapshot: unknown, opts: Pick<RunDescendantScanOptions, "procRoot"> = {}): RunProcessLineage | null {
    if (!snapshot || typeof snapshot !== "object") return null;
    const raw = snapshot as Partial<RunLineageSnapshot>;
    if (raw.version !== 1 || typeof raw.runId !== "string" || !Array.isArray(raw.entries)) return null;
    const bootId = readBootId(opts);
    if (!bootId || raw.bootId !== bootId) return null;
    return new RunProcessLineage(
      raw.runId,
      raw.entries.filter(
        (entry): entry is RunLineageEntry =>
          !!entry && typeof entry === "object" && typeof entry.pid === "number" && typeof entry.startTime === "string",
      ),
    );
  }

  toSnapshot(): RunLineageSnapshot {
    return {
      version: 1,
      runId: this.runId,
      bootId: readBootId(),
      entries: [...this.recorded.values()].map((entry) => ({ ...entry })),
    };
  }

  /** True when the recorded set changed since the last call. */
  takeChanged() {
    const changed = this.changed;
    this.changed = false;
    return changed;
  }

  /** Adds the processes another lineage of the same run recorded, for example a saved one. */
  absorb(other: RunProcessLineage) {
    if (other.runId !== this.runId) return;
    for (const [key, entry] of other.recorded) {
      const existing = this.recorded.get(key);
      if (!existing) {
        this.recorded.set(key, { ...entry });
        this.changed = true;
      } else if (entry.leader && !existing.leader) {
        existing.leader = true;
        this.changed = true;
      }
    }
  }

  /** Records a known run process, for example the CLI the adapter spawned. */
  addRoot(pid: number, opts: Pick<RunDescendantScanOptions, "procRoot"> = {}) {
    if (!isSupported() || !Number.isInteger(pid) || pid <= 1) return;
    const stat = readStat(opts.procRoot ?? "/proc", pid);
    if (!stat || isGoneState(stat.state)) return;
    this.record({ pid, startTime: stat.startTime, ppid: stat.ppid, pgid: stat.pgid, sid: stat.sid });
  }

  private record(entry: ProcEntry) {
    const key = identityKey(entry);
    const leader = entry.sid === entry.pid || entry.pgid === entry.pid;
    const existing = this.recorded.get(key);
    if (existing) {
      if (leader && !existing.leader) {
        existing.leader = true;
        this.changed = true;
      }
      return;
    }
    this.recorded.set(key, { pid: entry.pid, startTime: entry.startTime, ...(leader ? { leader: true } : {}) });
    this.changed = true;
  }

  private isMarked(table: RunProcessTable, entry: ProcEntry) {
    const key = identityKey(entry);
    let marked = this.markerCache.get(key);
    if (marked === undefined) {
      marked = hasRunMarker(table.procRoot, entry.pid, this.needle);
      // The PID could have been reused while the environment was read.
      const after = readStat(table.procRoot, entry.pid);
      if (!after || after.startTime !== entry.startTime) return false;
      this.markerCache.set(key, marked);
    }
    return marked;
  }

  /**
   * Reads the environment of processes in `table` not seen before, without
   * blocking the event loop, so that {@link sample} needs no further reads.
   */
  async loadMarkers(table: RunProcessTable) {
    if (!isSupported()) return;
    const pending = [...table.entries.values()].filter((entry) => {
      const key = identityKey(entry);
      return !this.markerCache.has(key) && !this.recorded.has(key);
    });
    for (let index = 0; index < pending.length; index += ASYNC_SCAN_BATCH) {
      await Promise.all(
        pending.slice(index, index + ASYNC_SCAN_BATCH).map(async (entry) => {
          let environ: Buffer;
          try {
            environ = await fsp.readFile(`${table.procRoot}/${entry.pid}/environ`);
          } catch {
            environ = Buffer.alloc(0);
          }
          // The PID could have been reused while the environment was read.
          const after = await readStatAsync(table.procRoot, entry.pid);
          if (!after || after.startTime !== entry.startTime) return;
          this.markerCache.set(identityKey(entry), environHasNeedle(environ, this.needle));
        }),
      );
    }
  }

  /** {@link sample} with the environment reads done asynchronously first. */
  async sampleAsync(table: RunProcessTable, opts: RunDescendantScanOptions = {}) {
    await this.loadMarkers(table);
    return this.sample(table, opts);
  }

  /**
   * Records every run process in `table` and returns the live ones, excluding
   * this process, its ancestors and the caller's exclusions.
   */
  sample(table: RunProcessTable, opts: RunDescendantScanOptions = {}): RunProcessIdentity[] {
    if (!isSupported() || !isValidRunId(this.runId)) return [];
    const { entries } = table;

    const excludedPids = protectedPids(table.procRoot);
    const blockedLeaders = new Set<number>();
    for (const pid of excludedPids) {
      const entry = entries.get(pid);
      if (entry) {
        blockedLeaders.add(entry.sid);
        blockedLeaders.add(entry.pgid);
      }
    }
    for (const pid of opts.excludePids ?? []) excludedPids.add(pid);
    const excludedGroups = new Set<number>();
    for (const pgid of opts.excludeProcessGroupIds ?? []) {
      if (Number.isInteger(pgid) && pgid > 0) {
        excludedGroups.add(pgid);
        blockedLeaders.add(pgid);
      }
    }
    const isExcluded = (entry: ProcEntry) => excludedPids.has(entry.pid) || excludedGroups.has(entry.pgid);

    // Mark recorded processes that are gone, and drop the ones that can no
    // longer explain a live process. Samples can overlap (the shared sampler,
    // tracking and teardown each read their own table), so a table whose read
    // started before one already applied only adds processes: it could lack a
    // child that the newer table recorded.
    const stale = typeof table.seq === "number" && table.seq < this.lastTableSeq;
    if (typeof table.seq === "number" && !stale) this.lastTableSeq = table.seq;
    const liveSidOrGroup = new Set<number>();
    for (const entry of entries.values()) {
      liveSidOrGroup.add(entry.sid);
      liveSidOrGroup.add(entry.pgid);
    }
    if (!stale) for (const [key, entry] of this.recorded) {
      const live = entries.get(entry.pid);
      if (live && live.startTime === entry.startTime) continue;
      if (!entry.leader || !liveSidOrGroup.has(entry.pid) || (live && live.startTime !== entry.startTime)) {
        this.recorded.delete(key);
        this.changed = true;
        continue;
      }
      if (entry.goneAtTicks === undefined) {
        entry.goneAtTicks = table.nowTicks;
        this.changed = true;
      }
    }

    // Session and group ids led by a recorded process, with the latest start
    // time a member may have.
    const leaders = new Map<number, number>();
    const addLeader = (entry: RunLineageEntry) => {
      if (!entry.leader || blockedLeaders.has(entry.pid)) return;
      leaders.set(entry.pid, entry.goneAtTicks ?? Number.MAX_SAFE_INTEGER);
    };
    for (const entry of this.recorded.values()) addLeader(entry);

    const owned = new Map<number, ProcEntry>();
    const own = (entry: ProcEntry) => {
      owned.set(entry.pid, entry);
      this.record(entry);
      const recorded = this.recorded.get(identityKey(entry));
      if (recorded) addLeader(recorded);
    };
    for (const entry of entries.values()) {
      if (isExcluded(entry)) continue;
      if (this.recorded.has(identityKey(entry)) || this.isMarked(table, entry)) own(entry);
    }

    const memberOf = (id: number, entry: ProcEntry) => {
      const latestStart = leaders.get(id);
      return latestStart !== undefined && Number(entry.startTime) <= latestStart;
    };
    // Bounded fixpoint: each pass adds at least one process or stops.
    for (let pass = 0; pass <= entries.size; pass += 1) {
      let added = false;
      for (const entry of entries.values()) {
        if (owned.has(entry.pid) || isExcluded(entry)) continue;
        const parent = owned.get(entry.ppid);
        const viaParent = !!parent && Number(parent.startTime) <= Number(entry.startTime);
        if (viaParent || memberOf(entry.sid, entry) || memberOf(entry.pgid, entry)) {
          own(entry);
          added = true;
        }
      }
      if (!added) break;
    }

    // Forget marker results for processes that are gone.
    const liveKeys = new Set([...entries.values()].map(identityKey));
    for (const key of this.markerCache.keys()) if (!liveKeys.has(key)) this.markerCache.delete(key);

    return [...owned.values()].map((entry) => ({ pid: entry.pid, startTime: entry.startTime }));
  }
}

/**
 * Wall-clock start time (ms since the epoch) of a live process, or null when
 * the PID is gone or the platform is unsupported. Precision is one clock tick.
 */
export function readProcessStartedAtMs(pid: number, opts: Pick<RunDescendantScanOptions, "procRoot"> = {}) {
  if (!isSupported() || !Number.isInteger(pid) || pid <= 0) return null;
  const procRoot = opts.procRoot ?? "/proc";
  const stat = readStat(procRoot, pid);
  if (!stat || isGoneState(stat.state)) return null;
  let uptimeSeconds: number;
  try {
    uptimeSeconds = Number.parseFloat(fs.readFileSync(`${procRoot}/uptime`, "utf8").split(/\s+/)[0] ?? "");
  } catch {
    return null;
  }
  if (!Number.isFinite(uptimeSeconds)) return null;
  const bootMs = Date.now() - uptimeSeconds * 1_000;
  return bootMs + (Number(stat.startTime) / USER_HZ) * 1_000;
}

/** Lists live processes of the current user that carry `PAPERCLIP_RUN_ID=<runId>`. */
export function findRunMarkedProcesses(
  runId: string,
  opts: RunDescendantScanOptions = {},
): RunProcessIdentity[] {
  if (!isSupported() || !isValidRunId(runId)) return [];
  const procRoot = opts.procRoot ?? "/proc";
  const table = readRunProcessTable({ procRoot });
  const excludedPids = protectedPids(procRoot);
  for (const pid of opts.excludePids ?? []) excludedPids.add(pid);
  const excludedGroups = new Set<number>();
  for (const pgid of opts.excludeProcessGroupIds ?? []) {
    if (Number.isInteger(pgid) && pgid > 0) excludedGroups.add(pgid);
  }
  const needle = markerNeedle(runId);
  const matches: RunProcessIdentity[] = [];
  for (const entry of table.entries.values()) {
    if (excludedPids.has(entry.pid) || excludedGroups.has(entry.pgid)) continue;
    if (!hasRunMarker(procRoot, entry.pid, needle)) continue;
    // The PID could have been reused while the environment was read.
    const after = readStat(procRoot, entry.pid);
    if (!after || after.startTime !== entry.startTime) continue;
    matches.push({ pid: entry.pid, startTime: entry.startTime });
  }
  return matches;
}

function isSameLiveProcess(procRoot: string, identity: RunProcessIdentity) {
  const stat = readStat(procRoot, identity.pid);
  return !!stat && stat.startTime === identity.startTime && !isGoneState(stat.state);
}

/**
 * Signals a process only if its PID still has the recorded start time.
 * Returns false (without signalling) for a gone or reused PID.
 */
export function signalRunProcessIdentity(
  identity: RunProcessIdentity,
  signal: NodeJS.Signals,
  opts: Pick<RunDescendantScanOptions, "procRoot"> = {},
) {
  return signalIdentity(opts.procRoot ?? "/proc", identity, signal);
}

function signalIdentity(procRoot: string, identity: RunProcessIdentity, signal: NodeJS.Signals) {
  // Re-check the start time right before the signal so a reused PID is skipped.
  if (!isSameLiveProcess(procRoot, identity)) return false;
  try {
    process.kill(identity.pid, signal);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Stops every live process of the run: first signal, a grace period, then
 * SIGKILL. The process table is scanned again on every poll during the grace
 * period; a run process that appears then (for example a cleanup child that a
 * SIGTERM handler starts) receives the first signal and the rest of the grace
 * period. The grace period ends early only when no run process is left. The
 * whole teardown is bounded by the grace period plus a short SIGKILL settle.
 * Calling it again for a finished run is a no-op.
 */
export async function terminateRunMarkedProcesses(
  runId: string,
  opts: RunDescendantTerminateOptions = {},
): Promise<RunDescendantTerminateResult> {
  const procRoot = opts.procRoot ?? "/proc";
  if (!isSupported() || !isValidRunId(runId)) return { found: [], forceKilled: [], survivors: [] };
  const lineage = opts.lineage ?? new RunProcessLineage(runId);
  const scan = async () => lineage.sampleAsync(await readRunProcessTableAsync({ procRoot }), opts);

  const graceMs = Math.max(0, opts.graceMs ?? 5_000);
  const pollMs = Math.max(10, opts.pollMs ?? 100);
  const signal = opts.signal ?? "SIGTERM";
  const found = new Map<string, RunProcessIdentity>();
  const deadline = Date.now() + graceMs;

  let current = await scan();
  if (current.length === 0) return { found: [], forceKilled: [], survivors: [] };
  while (current.length > 0) {
    for (const identity of current) {
      const key = identityKey(identity);
      if (found.has(key)) continue;
      found.set(key, identity);
      signalIdentity(procRoot, identity, signal);
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    current = await scan();
  }

  // Kill what is left, scanning again so that a child started just before
  // its parent was killed is not missed.
  const forceKilled = new Map<string, RunProcessIdentity>();
  const settleDeadline = Date.now() + KILL_SETTLE_MS;
  let survivors: RunProcessIdentity[] = [];
  while (current.length > 0) {
    for (const identity of current) {
      const key = identityKey(identity);
      if (!found.has(key)) found.set(key, identity);
      if (signalIdentity(procRoot, identity, "SIGKILL")) forceKilled.set(key, identity);
    }
    if (Date.now() >= settleDeadline) {
      survivors = current.filter((identity) => isSameLiveProcess(procRoot, identity));
      break;
    }
    await delay(Math.min(pollMs, 50));
    current = await scan();
  }
  return { found: [...found.values()], forceKilled: [...forceKilled.values()], survivors };
}
