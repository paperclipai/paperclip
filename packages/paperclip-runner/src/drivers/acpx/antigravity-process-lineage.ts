import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

/**
 * Every process the swarm route's `agy acp` launcher and its helpers start,
 * recorded while they are still visible, so they can all be stopped when the
 * CLI exits for any reason.
 *
 * The CLI starts each helper shell command as its own process-group leader.
 * When the CLI dies those commands are re-parented, so signalling the
 * launcher's group (retireAntigravityProcess) does not reach them.
 *
 * runnerd's LineageTracker (runner-core process_lineage.rs) records the whole
 * sidecar's lineage and stops all of it, the sidecar included, when the
 * sidecar is torn down. It has no operation for one subtree, and the swarm
 * needs this subtree stopped while the sidecar keeps serving the run: before a
 * lost, stopped or timed-out swarm turn is reported. This tracker applies
 * runnerd's membership rules to the CLI's subtree only:
 * - a process belongs when its parent belongs (and started no later than it);
 * - or when it is in a group or session a member leads and started no earlier
 *   than that leader (sessions on Linux; macOS `ps` reports no session id);
 * - identity is PID plus start time, re-read immediately before each signal,
 *   so a reused PID is never signalled;
 * - a recorded member whose details cannot be read stays unresolved, and a
 *   table read that does not list this process is rejected: neither proves
 *   the lineage gone;
 * - membership never depends on a command name, so other `agy` processes of
 *   the same user are never touched.
 */
export interface LineageEntry { pid: number; ppid: number; pgid: number; sid: number | null; started: number; zombie: boolean }

/** One read of the process table: readable entries, and PIDs that exist but could not be read. */
export interface ProcessTableRead { entries: LineageEntry[]; unreadable: number[] }

export interface LineageObservation { live: LineageEntry[]; unresolved: number[] }

export class LineageState {
  readonly #members = new Map<number, number>();
  readonly #groups = new Map<number, number>();
  readonly #sessions = new Map<number, number>();
  readonly #root: { pid: number; started: number | null };

  constructor(rootPid: number) { this.#root = { pid: rootPid, started: null }; }

  /** Updates membership from one table read, applied in the order reads were taken. */
  observe(read: ProcessTableRead | readonly LineageEntry[]): LineageObservation {
    const { entries, unreadable } = Array.isArray(read) ? { entries: read as readonly LineageEntry[], unreadable: [] as number[] } : read as ProcessTableRead;
    const byPid = new Map(entries.map(entry => [entry.pid, entry]));
    const unknown = new Set(unreadable);
    const root = byPid.get(this.#root.pid);
    if (root && !root.zombie && (this.#root.started === null || this.#root.started === root.started)) {
      this.#root.started = root.started;
      this.#members.set(root.pid, root.started);
    }
    // A PID that now names a different process is forgotten first, so it can
    // never admit that process's children. Members that merely exited are
    // forgotten only after admission: a child whose parent exited since the
    // last read is still found through that parent's recorded group or session.
    for (const records of [this.#members, this.#groups, this.#sessions]) {
      for (const [id, started] of records) {
        const current = byPid.get(id);
        if (current && current.started !== started) records.delete(id);
      }
    }
    const record = (entry: LineageEntry) => {
      this.#members.set(entry.pid, entry.started);
      if (entry.pgid === entry.pid) this.#groups.set(entry.pid, entry.started);
      if (entry.sid === entry.pid) this.#sessions.set(entry.pid, entry.started);
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const entry of entries) {
        if (entry.zombie || this.#members.has(entry.pid) || entry.pid <= 1 || entry.pid === process.pid) continue;
        const leader = (records: Map<number, number>, id: number | null) => id !== null && (records.get(id) ?? Infinity) <= entry.started;
        if (leader(this.#members, entry.ppid) || leader(this.#groups, entry.pgid) || leader(this.#sessions, entry.sid)) {
          record(entry);
          changed = true;
        }
      }
    }
    const live: LineageEntry[] = [];
    const unresolved: number[] = [];
    for (const [pid, started] of this.#members) {
      const entry = byPid.get(pid);
      if (!entry) {
        // Its exit is proven only when the PID is absent, not when it is unreadable.
        if (unknown.has(pid)) unresolved.push(pid); else this.#members.delete(pid);
        continue;
      }
      if (entry.started !== started || entry.zombie) { this.#members.delete(pid); continue; }
      record(entry);
      live.push(entry);
    }
    return { live, unresolved };
  }
}

/** `/bin/ps -A -o pid=,ppid=,pgid=,stat=,lstart=` output, read with LANG=C and TZ=UTC. */
export function parsePsTable(output: string): ProcessTableRead {
  const entries: LineageEntry[] = [];
  const unreadable: number[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [pid, ppid, pgid, stat, ...start] = line.trim().split(/\s+/);
    if (!pid || !/^\d+$/.test(pid)) throw new Error("Unexpected process table output");
    const started = start.length === 5 ? Date.parse(`${start.join(" ")} UTC`) : Number.NaN;
    if (!/^\d+$/.test(ppid ?? "") || !/^\d+$/.test(pgid ?? "") || !/^[A-Za-z+<>NLsWX-]+$/.test(stat ?? "") || !Number.isFinite(started)) {
      unreadable.push(Number(pid));
      continue;
    }
    entries.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), sid: null, started, zombie: stat!.startsWith("Z") });
  }
  return { entries, unreadable };
}

/** `/proc/<pid>/stat` content: state ppid pgrp session ... starttime follow the command name. */
export function parseProcStat(pid: number, stat: string): LineageEntry | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
  const [ppid, pgid, sid, started] = [fields[1], fields[2], fields[3], fields[19]].map(Number);
  if (![ppid, pgid, sid, started].every(Number.isSafeInteger) || !fields[0]) return null;
  return { pid, ppid: ppid!, pgid: pgid!, sid: sid!, started: started!, zombie: fields[0] === "Z" || fields[0] === "X" };
}

async function readLinuxEntry(pid: number): Promise<LineageEntry | "gone" | "unreadable"> {
  try { return parseProcStat(pid, await readFile(`/proc/${pid}/stat`, "utf8")) ?? "unreadable"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unreadable"; }
}

function runPs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("/bin/ps", args, {
    encoding: "utf8", timeout: 2_000, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/** One read of this host's process table: /proc on Linux, /bin/ps on macOS. Numbers only; never arguments or environment. */
export async function readProcessTable(platform: NodeJS.Platform = process.platform): Promise<ProcessTableRead> {
  let read: ProcessTableRead;
  if (platform === "linux") {
    const pids = (await readdir("/proc")).filter(name => /^\d+$/.test(name)).map(Number);
    const rows = await Promise.all(pids.map(async pid => ({ pid, row: await readLinuxEntry(pid) })));
    read = {
      entries: rows.flatMap(({ row }) => typeof row === "object" ? [row] : []),
      unreadable: rows.flatMap(({ pid, row }) => row === "unreadable" ? [pid] : []),
    };
  } else if (platform === "darwin") {
    read = parsePsTable(await runPs(["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="]));
  } else {
    throw new Error("Antigravity process lineage is not supported on this platform");
  }
  return assertCompleteRead(read);
}

/** A read that does not list this very process cannot prove anything absent. */
function assertCompleteRead(read: ProcessTableRead): ProcessTableRead {
  if (!read.entries.some(entry => entry.pid === process.pid)) throw new Error("The process table read is incomplete");
  return read;
}

/** The current start time of each PID still alive and readable (one `ps` for all of them on macOS). */
async function currentStarts(pids: readonly number[]): Promise<Map<number, number>> {
  const starts = new Map<number, number>();
  if (pids.length === 0) return starts;
  if (process.platform === "linux") {
    for (const pid of pids) {
      const row = await readLinuxEntry(pid);
      if (typeof row === "object" && !row.zombie) starts.set(pid, row.started);
    }
    return starts;
  }
  const output = await runPs(["-o", "pid=,ppid=,pgid=,stat=,lstart=", "-p", pids.join(",")]).catch(() => "");
  let read: ProcessTableRead = { entries: [], unreadable: [] };
  try { read = parsePsTable(output); } catch { /* nothing is signalled */ }
  for (const entry of read.entries) if (!entry.zombie) starts.set(entry.pid, entry.started);
  return starts;
}

export interface AntigravityProcessLineage {
  /**
   * Stops every recorded process that is still alive and proves none remain.
   * A proven result is kept; a call after a failed one tries again.
   */
  terminate(): Promise<void>;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 200;
const TERMINATE_DEADLINE_MS = 1_500;

/** Records the lineage of `rootPid` at once, then every `sampleIntervalMs` until terminate(). */
export function trackAntigravityProcessLineage(rootPid: number | undefined, options: {
  sampleIntervalMs?: number; readTable?: () => Promise<ProcessTableRead>;
} = {}): AntigravityProcessLineage {
  if (rootPid === undefined || process.platform === "win32") return { terminate: async () => {} };
  const readTable = options.readTable ?? (() => readProcessTable());
  const state = new LineageState(rootPid);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Reads are applied in the order they were taken, never two at once.
  let reading: Promise<unknown> = Promise.resolve();
  const sample = (): Promise<LineageObservation> => {
    const next = reading.catch(() => undefined).then(() => readTable()).then(read => state.observe(assertCompleteRead(read)));
    reading = next;
    return next;
  };
  const loop = () => {
    if (stopped) return;
    void sample().catch(() => undefined).finally(() => {
      if (stopped) return;
      timer = setTimeout(loop, options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
      timer.unref?.();
    });
  };
  loop();
  let termination: Promise<void> | null = null;
  return {
    terminate: () => termination ??= (async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      const deadline = Date.now() + TERMINATE_DEADLINE_MS;
      for (let round = 0; ; round++) {
        // A fresh read each round: a member that forked meanwhile is found by its parent, group or session.
        // A failed read proves nothing, so it is retried until the deadline.
        const observed = await sample().catch(() => null);
        if (observed && observed.live.length === 0 && observed.unresolved.length === 0) return;
        // The first round signals what it found even when that read was slow; later rounds keep the deadline.
        if (round > 0 && Date.now() >= deadline) throw new Error("Antigravity helper processes could not be stopped");
        // Re-read the identities just before the signals: a PID reused since the read is never signalled.
        const live = observed?.live ?? [];
        const starts = await currentStarts(live.map(entry => entry.pid));
        for (const entry of live) {
          if (starts.get(entry.pid) !== entry.started) continue;
          try { process.kill(entry.pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })().catch(error => { termination = null; throw error; }),
  };
}
