import fs from "node:fs";

/**
 * Finds and stops processes that a local agent run left behind.
 *
 * A local adapter starts its CLI in a new process group and run teardown
 * signals that group. Tools inside the CLI can leave it: Claude Code runs each
 * Bash tool call in a new session (setsid), and `nohup`, `setsid` or a double
 * fork move a server out of the group and reparent it to init. A group signal
 * then never reaches it and it outlives the run.
 *
 * Every local run exports `PAPERCLIP_RUN_ID=<run id>` to its CLI and the CLI's
 * descendants inherit it, whatever group or session they move to. The initial
 * environment of a process cannot be rewritten after exec, so the marker in
 * `/proc/<pid>/environ` stays stable for the process's life. The run id is a
 * per-run UUID, so the match is exact to one run.
 *
 * Safety rules:
 * - Linux only. Elsewhere the functions find nothing and the caller keeps its
 *   existing process-group teardown.
 * - Only processes owned by the current user are considered.
 * - The current process and its ancestors are never matched, so a Paperclip
 *   server started inside an agent run does not stop itself.
 * - A process is identified by PID plus kernel start time. The start time is
 *   read again before each signal, so a reused PID is never signalled.
 * - Callers can exclude PIDs and process groups that another owner tracks
 *   (for example a server-managed runtime service).
 *
 * Known limit: a descendant that discards its environment (`env -i`) or runs
 * as another user is not matched.
 */

export const RUN_ID_ENV_MARKER = "PAPERCLIP_RUN_ID";

export interface RunProcessIdentity {
  pid: number;
  /** Kernel start time in clock ticks since boot (`/proc/<pid>/stat` field 22). */
  startTime: string;
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
}

export interface RunDescendantTerminateResult {
  /** Processes found on the first scan. */
  found: RunProcessIdentity[];
  /** Processes that received SIGKILL because they did not stop in the grace period. */
  forceKilled: RunProcessIdentity[];
  /** Processes still alive after SIGKILL and a short wait. */
  survivors: RunProcessIdentity[];
}

interface ProcStat {
  ppid: number;
  pgid: number;
  state: string;
  startTime: string;
}

const MAX_RUN_ID_LENGTH = 256;
const KILL_SETTLE_MS = 1_000;

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

function readStat(procRoot: string, pid: number): ProcStat | null {
  let raw: string;
  try {
    raw = fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // The command name (field 2) can contain spaces and parentheses.
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state); field N is fields[N - 3].
  const state = fields[0];
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  const pgid = Number.parseInt(fields[2] ?? "", 10);
  const startTime = fields[19];
  if (!state || !Number.isInteger(ppid) || !Number.isInteger(pgid) || !startTime || !/^\d+$/.test(startTime)) {
    return null;
  }
  return { ppid, pgid, state, startTime };
}

function isGoneState(state: string) {
  return state === "Z" || state === "X" || state === "x";
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
  if (environ.length === 0) return false;
  // Entries are NUL-terminated; prefix a NUL so the first entry matches too.
  const haystack = Buffer.concat([Buffer.from([0]), environ, Buffer.from([0])]);
  return haystack.indexOf(needle) >= 0;
}

/** Lists live processes of the current user that carry `PAPERCLIP_RUN_ID=<runId>`. */
export function findRunMarkedProcesses(
  runId: string,
  opts: RunDescendantScanOptions = {},
): RunProcessIdentity[] {
  if (!isSupported() || !isValidRunId(runId)) return [];
  const procRoot = opts.procRoot ?? "/proc";
  const uid = process.getuid!();
  const excludedPids = protectedPids(procRoot);
  for (const pid of opts.excludePids ?? []) excludedPids.add(pid);
  const excludedGroups = new Set<number>();
  for (const pgid of opts.excludeProcessGroupIds ?? []) {
    if (Number.isInteger(pgid) && pgid > 0) excludedGroups.add(pgid);
  }
  const needle = Buffer.from(`\0${RUN_ID_ENV_MARKER}=${runId}\0`);

  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return [];
  }

  const matches: RunProcessIdentity[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    if (!(pid > 1) || excludedPids.has(pid)) continue;
    try {
      if (fs.statSync(`${procRoot}/${name}`).uid !== uid) continue;
    } catch {
      continue;
    }
    const before = readStat(procRoot, pid);
    if (!before || isGoneState(before.state) || excludedGroups.has(before.pgid)) continue;
    if (!hasRunMarker(procRoot, pid, needle)) continue;
    // The PID could have been reused while the environment was read.
    const after = readStat(procRoot, pid);
    if (!after || after.startTime !== before.startTime) continue;
    matches.push({ pid, startTime: before.startTime });
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

function identityKey(identity: RunProcessIdentity) {
  return `${identity.pid}:${identity.startTime}`;
}

/**
 * Stops every live process marked with the run id: first signal, a grace
 * period, then SIGKILL. A process that appears during the grace period is
 * included in the SIGKILL pass. Calling it again for a finished run is a no-op.
 */
export async function terminateRunMarkedProcesses(
  runId: string,
  opts: RunDescendantTerminateOptions = {},
): Promise<RunDescendantTerminateResult> {
  const procRoot = opts.procRoot ?? "/proc";
  const found = findRunMarkedProcesses(runId, opts);
  if (found.length === 0) return { found, forceKilled: [], survivors: [] };

  const graceMs = Math.max(0, opts.graceMs ?? 5_000);
  const pollMs = Math.max(10, opts.pollMs ?? 100);
  const signal = opts.signal ?? "SIGTERM";
  for (const identity of found) signalIdentity(procRoot, identity, signal);

  const deadline = Date.now() + graceMs;
  let tracked = found.filter((identity) => isSameLiveProcess(procRoot, identity));
  while (tracked.length > 0 && Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    tracked = tracked.filter((identity) => isSameLiveProcess(procRoot, identity));
  }

  // Include anything started with the marker while the first signal was handled.
  const remaining = new Map<string, RunProcessIdentity>();
  for (const identity of tracked) remaining.set(identityKey(identity), identity);
  for (const identity of findRunMarkedProcesses(runId, opts)) remaining.set(identityKey(identity), identity);

  const forceKilled: RunProcessIdentity[] = [];
  for (const identity of remaining.values()) {
    if (signalIdentity(procRoot, identity, "SIGKILL")) forceKilled.push(identity);
  }

  let survivors = forceKilled;
  const settleDeadline = Date.now() + KILL_SETTLE_MS;
  while (survivors.length > 0) {
    survivors = survivors.filter((identity) => isSameLiveProcess(procRoot, identity));
    if (survivors.length === 0 || Date.now() >= settleDeadline) break;
    await delay(Math.min(pollMs, 50));
  }
  return { found, forceKilled, survivors };
}
