import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

/**
 * Every process the swarm route's `agy acp` launcher and its helpers start,
 * recorded while they are still visible, so they can all be stopped when the
 * CLI exits for any reason.
 *
 * The CLI starts each helper shell command as its own process-group leader.
 * When the CLI dies those commands are re-parented, so signalling the
 * launcher's group (retireAntigravityProcess) does not reach them. runnerd's
 * LineageTracker (runner-core process_lineage.rs) records the same thing for
 * the whole sidecar, but acts only when the sidecar is torn down, after the
 * turn's outcome is already published. This tracker applies the same
 * membership rules to the CLI's own subtree so the swarm stops it before it
 * reports the turn's outcome:
 * - a process belongs when its parent belongs (and started no later than it),
 * - or when it is in a group a member leads and started no earlier than that
 *   group's leader;
 * - identity is PID plus start time, so a reused PID is never signalled;
 * - membership never depends on a command name, so other `agy` processes of
 *   the same user are never touched.
 */
export interface LineageEntry { pid: number; ppid: number; pgid: number; started: number; zombie: boolean }

export class LineageState {
  readonly #members = new Map<number, number>();
  readonly #groups = new Map<number, number>();
  readonly #root: { pid: number; started: number | null };

  constructor(rootPid: number) { this.#root = { pid: rootPid, started: null }; }

  /** Updates membership from one table read and returns the live members. */
  observe(entries: readonly LineageEntry[]): LineageEntry[] {
    const byPid = new Map(entries.map(entry => [entry.pid, entry]));
    const root = byPid.get(this.#root.pid);
    if (root && !root.zombie && (this.#root.started === null || this.#root.started === root.started)) {
      this.#root.started = root.started;
      this.#members.set(root.pid, root.started);
    }
    // A PID or group id that now names a different process is forgotten first,
    // so it can never admit that process's children. Members that merely exited
    // are forgotten only after admission: a child whose parent exited since the
    // last read is still found through that parent's recorded group.
    const reused = (records: Map<number, number>) => {
      for (const [id, started] of records) {
        const current = byPid.get(id);
        if (current && current.started !== started) records.delete(id);
      }
    };
    reused(this.#members);
    reused(this.#groups);
    for (let changed = true; changed;) {
      changed = false;
      for (const entry of entries) {
        if (entry.zombie || this.#members.has(entry.pid) || entry.pid <= 1 || entry.pid === process.pid) continue;
        const parent = this.#members.get(entry.ppid);
        const group = this.#groups.get(entry.pgid);
        if ((parent !== undefined && parent <= entry.started) || (group !== undefined && group <= entry.started)) {
          this.#members.set(entry.pid, entry.started);
          if (entry.pgid === entry.pid) this.#groups.set(entry.pid, entry.started);
          changed = true;
        }
      }
    }
    for (const [pid, started] of this.#members) {
      const entry = byPid.get(pid);
      if (!entry || entry.started !== started || entry.zombie) { this.#members.delete(pid); continue; }
      if (entry.pgid === pid) this.#groups.set(pid, started);
    }
    return [...this.#members.keys()].map(pid => byPid.get(pid)!);
  }
}

/** One read of this host's process table: /proc on Linux, /bin/ps on macOS. Numbers only; never arguments or environment. */
export async function readProcessTable(platform: NodeJS.Platform = process.platform): Promise<LineageEntry[]> {
  if (platform === "linux") {
    const names = (await readdir("/proc")).filter(name => /^\d+$/.test(name));
    const rows = await Promise.all(names.map(async name => {
      try {
        const stat = await readFile(`/proc/${name}/stat`, "utf8");
        // Fields after the command name: state ppid pgrp session ... starttime (index 19).
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return { pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), started: Number(fields[19]), zombie: fields[0] === "Z" || fields[0] === "X" };
      } catch { return null; }
    }));
    return rows.filter((row): row is LineageEntry => row !== null && [row.ppid, row.pgid, row.started].every(Number.isSafeInteger));
  }
  if (platform !== "darwin") throw new Error("Antigravity process lineage is not supported on this platform");
  const output = await new Promise<string>((resolve, reject) => execFile("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const entries: LineageEntry[] = [];
  for (const line of output.split("\n")) {
    const [pid, ppid, pgid, stat, ...start] = line.trim().split(/\s+/);
    const started = Date.parse(`${start.join(" ")} UTC`);
    if (!pid || !/^\d+$/.test(pid) || !/^\d+$/.test(ppid ?? "") || !/^\d+$/.test(pgid ?? "") || !Number.isFinite(started)) continue;
    entries.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), started, zombie: stat?.startsWith("Z") ?? false });
  }
  return entries;
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
  sampleIntervalMs?: number; readTable?: () => Promise<LineageEntry[]>;
} = {}): AntigravityProcessLineage {
  if (rootPid === undefined || process.platform === "win32") return { terminate: async () => {} };
  const readTable = options.readTable ?? (() => readProcessTable());
  const state = new LineageState(rootPid);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Reads are applied in the order they were taken, never two at once.
  let reading: Promise<unknown> = Promise.resolve();
  const sample = (): Promise<LineageEntry[]> => {
    const next = reading.catch(() => undefined).then(() => readTable()).then(entries => state.observe(entries));
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
      for (;;) {
        // A fresh read each round: a member that forked meanwhile is found by its parent or group.
        // A failed read proves nothing, so it is retried until the deadline.
        const live = await sample().catch(() => null);
        if (live?.length === 0) return;
        if (Date.now() >= deadline) throw new Error("Antigravity helper processes could not be stopped");
        if (!live) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
        for (const entry of live) {
          try { process.kill(entry.pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })().catch(error => { termination = null; throw error; }),
  };
}
