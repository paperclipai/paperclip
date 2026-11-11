/**
 * Class R cells (CR1–CR3): the staging failure `runner_remote_process_identity_unavailable`
 * (doc/plans/2026-11-11-staging-failures-vs-chaos-coverage.md, class R).
 *
 * On staging, 8 of 9 such runs crossed a deploy that kept the controller away for 5–7 minutes. The Runner in
 * the Daytona sandbox survived and was adopted, but about 40 s later `session.snapshot` failed because the
 * provider process inside the sandbox was dead or unresponsive ("ACPX request snapshot requires the surviving
 * provider"). The ninth run had no deploy: a plugin `environmentExecute` RPC stalled for more than 40 s.
 *
 * - CR1: a K15 redeploy whose outage is held `--cr1-hold-seconds` (default 360 s), then the next deploy.
 * - CR2: only the provider process inside the task's sandbox is killed with SIGKILL; the Runner stays alive.
 *   The controller stays up, or with `--cr2-hold-seconds <n>` a K15 redeploy holds it down for `n` seconds and
 *   the provider is killed right after the controller stopped.
 * - CR3: the server's Daytona plugin worker is stopped (SIGSTOP) for `--cr3-stall-seconds` (default 45 s,
 *   more than 40), so every plugin RPC, `environmentExecute` included, stalls with no deploy.
 *
 * Every CR cell also captures the sandbox side (daytona-runner-logs.ts, extended probe): just before the fault,
 * right after the stop, before the next deploy starts, every few seconds for the first minutes after the
 * controller is ready again, when the task rests and at wave end. The Runner itself discards its own stdout and
 * stderr in a remote sandbox (`REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT` sends them to /dev/null), so these captures,
 * the Runner's durable state and the provider's own files are the only sandbox-side record.
 *
 * Harness only: no product code changes. The one in-sandbox mutation is CR2's SIGKILL of the provider
 * process, run by a fixed script in sandboxes labelled with this wave's company and environment.
 */
import type { AdapterId, FaultKind, FaultReceipt, WaveOptions } from "./types.js";
import { ProcessFreezer, descendantPids, readProcessTable, type ProcessRow } from "./time-faults.js";

export const CLASS_R_FAULT_KINDS = ["CR1", "CR2", "CR3"] as const;
export type ClassRFaultKind = (typeof CLASS_R_FAULT_KINDS)[number];

export function isClassRFault(kind: string): kind is ClassRFaultKind {
  return (CLASS_R_FAULT_KINDS as readonly string[]).includes(kind);
}

/** Staging deploys kept the controller away for 5–7 minutes. */
export const CR1_DEFAULT_HOLD_SECONDS = 360;
/** Staging's ninth run stalled one plugin RPC for more than 40 s. */
export const CR3_DEFAULT_STALL_SECONDS = 45;
export const CR3_MIN_STALL_SECONDS = 41;
/** The controller-outage cap (tests/runner-e2e/controller-outage.ts), as for K15. */
export const CLASS_R_MAX_HOLD_SECONDS = 600;

function parseRange(raw: string, flag: string, min: number, max: number): [number, number] {
  const match = /^([0-9]+)(?:-([0-9]+))?$/.exec(raw.trim());
  if (!match) throw new Error(`--${flag} takes <seconds> or <min>-<max> seconds`);
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : Number(match[2]);
  if (low < min || high > max || high < low) throw new Error(`--${flag} must be between ${min} and ${max} seconds, min not above max`);
  return [low * 1000, high * 1000];
}

/**
 * `--cr1-hold-seconds`, `--cr2-hold-seconds` and `--cr3-stall-seconds`. Class R cells need Daytona: the fault and
 * the evidence are both inside the remote sandbox. They do not join a storm, a crash-point wave or MS1–MS3.
 */
export function parseClassROptions(options: Pick<WaveOptions, "env" | "faults" | "stormMinutes" | "crashPoint">,
  values: { cr1?: string; cr2?: string; cr3?: string }): Pick<WaveOptions, "cr1HoldMs" | "cr2HoldMs" | "cr3StallMs"> {
  const kinds = options.faults.filter(isClassRFault);
  const given = { CR1: values.cr1, CR2: values.cr2, CR3: values.cr3 } as const;
  const flags = { CR1: "cr1-hold-seconds", CR2: "cr2-hold-seconds", CR3: "cr3-stall-seconds" } as const;
  for (const kind of CLASS_R_FAULT_KINDS) {
    if (given[kind] !== undefined && !kinds.includes(kind)) throw new Error(`--${flags[kind]} sets ${kind}; add ${kind} to --faults`);
  }
  if (!kinds.length) return {};
  if (options.env !== "daytona") throw new Error("Class R faults (CR1-CR3) act on the remote Daytona sandbox; run them with --env daytona");
  if (options.stormMinutes) throw new Error("Class R faults (CR1-CR3) are planned per task; do not combine them with --storm-minutes");
  if (options.crashPoint) throw new Error("Class R faults (CR1-CR3) do not combine with --crash-point");
  if (options.faults.some(kind => kind.startsWith("MS"))) throw new Error("Class R faults (CR1-CR3) do not combine with MS1-MS3");
  return {
    ...(kinds.includes("CR1") ? { cr1HoldMs: parseRange(values.cr1 ?? String(CR1_DEFAULT_HOLD_SECONDS), flags.CR1, 0, CLASS_R_MAX_HOLD_SECONDS) } : {}),
    ...(kinds.includes("CR2") ? { cr2HoldMs: parseRange(values.cr2 ?? "0", flags.CR2, 0, CLASS_R_MAX_HOLD_SECONDS) } : {}),
    ...(kinds.includes("CR3") ? { cr3StallMs: parseRange(values.cr3 ?? String(CR3_DEFAULT_STALL_SECONDS), flags.CR3, CR3_MIN_STALL_SECONDS, CLASS_R_MAX_HOLD_SECONDS) } : {}),
  };
}

/** The seeded hold of one class R cell; draws only for CR cells, so other seeds keep their plans. */
export function classRHoldMs(kind: FaultKind, options: Pick<WaveOptions, "cr1HoldMs" | "cr2HoldMs" | "cr3StallMs">,
  int: (min: number, max: number) => number): number {
  const range = kind === "CR1" ? options.cr1HoldMs ?? [CR1_DEFAULT_HOLD_SECONDS * 1000, CR1_DEFAULT_HOLD_SECONDS * 1000]
    : kind === "CR2" ? options.cr2HoldMs ?? [0, 0]
      : kind === "CR3" ? options.cr3StallMs ?? [CR3_DEFAULT_STALL_SECONDS * 1000, CR3_DEFAULT_STALL_SECONDS * 1000] : null;
  if (!range) return 0;
  return range[0] === range[1] ? range[0] : int(range[0], range[1]);
}

/** CR1, and CR2 with a hold, replace the controller as a deploy does (K15). */
/** Class R hooks (main.ts sets them on CR waves): sandbox captures and CR2's provider kill. None may throw. */
export interface ClassRHooks {
  /** Captures every wave sandbox under `label`; returns the label for the receipt. */
  capture(label: string, deadlineMs?: number): Promise<string>;
  /** CR2: SIGKILL the provider process of the task's current run inside its sandbox. */
  killProvider(requestedBy: string): Promise<ProviderKillRecord>;
  /** After the controller is ready again: keep capturing through the window staging failed in. */
  watchAfterReady(receipt: FaultReceipt): void;
}

export function classRRedeploys(kind: FaultKind, holdMs: number): boolean {
  return kind === "CR1" || (kind === "CR2" && holdMs > 0);
}

/**
 * The provider process each adapter's Runner supervises, matched against the full argument list of the Runner's
 * descendants. Observed in K15 sandbox captures (w-20261111T022637-s9311): Claude runs through the ACPX sidecar
 * as `<claude> --output-format stream-json ...`; OpenCode runs as `<opencode> serve --hostname 127.0.0.1 --port N`.
 */
export const PROVIDER_PROCESS_PATTERN: Record<AdapterId, string> = {
  claude: "--output-format stream-json",
  opencode: " serve --hostname 127.0.0.1 --port ",
  codex: " app-server",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * CR2's fixed in-sandbox script. Arguments: `$1` the run id the Runner listens for, `$2` the provider pattern.
 * It finds the `paperclip-runnerd` whose listen path names this run, walks its descendants, SIGKILLs only the
 * ones whose arguments contain the pattern, and prints the process table with start times before and after.
 * Exit 3: no Runner for this run here (another task's sandbox). Exit 4: the Runner has no provider process.
 * Exit 5: a selected process was still alive after the signal; `== killed` is printed only for confirmed deaths.
 */
export const PROVIDER_KILL_SCRIPT = [
  "set -u",
  "run_id=$1; pattern=$2",
  'runner=""; for p in $(ps -eo pid= 2>/dev/null); do a=$(tr "\\000" " " < /proc/$p/cmdline 2>/dev/null) || continue;'
    + ' case "$a" in *paperclip-runnerd*"/connect/$run_id"*) runner=$p; break;; esac; done',
  'test -n "$runner" || exit 3',
  'all=$runner; frontier=$runner; while test -n "$frontier"; do next=""; for p in $frontier; do next="$next $(ps -o pid= --ppid "$p" 2>/dev/null | tr "\\n" " ")"; done;'
    + ' frontier=$(echo $next); all="$all $frontier"; done',
  'targets=""; for p in $all; do test "$p" = "$runner" && continue; a=$(tr "\\000" " " < /proc/$p/cmdline 2>/dev/null) || continue;'
    + ' case "$a" in *"$pattern"*) targets="$targets $p";; esac; done',
  'echo "== runner $runner"',
  'echo "== before $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"; ps -o pid,ppid,sid,lstart,etimes,stat,wchan:24,args -p "$(echo $all | tr " " ",")" 2>/dev/null | cut -c1-300',
  'test -n "$targets" || exit 4',
  'kill -KILL $targets 2>/dev/null',
  // Only a process that is gone counts: a failed signal or a survivor fails the fault (exit 5).
  'alive=""; wait_ticks=0; while test "$wait_ticks" -lt 20; do alive=""; for p in $targets; do'
    + ' if kill -0 "$p" 2>/dev/null && ! grep -qs "^State:[[:space:]]*Z" /proc/$p/status; then alive="$alive $p"; fi; done;'
    + ' test -z "$alive" && break; wait_ticks=$((wait_ticks + 1)); sleep 0.1; done',
  'if test -n "$alive"; then echo "== survived$alive"; exit 5; fi',
  'echo "== killed$targets at $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"',
  "sleep 1",
  'echo "== after $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"; ps -o pid,ppid,sid,lstart,etimes,stat,wchan:24,args -p "$(echo $all | tr " " ",")" 2>/dev/null | cut -c1-300',
  "exit 0",
].join("\n");

/** The command CR2 sends through the Daytona toolbox: the fixed script, its two arguments single-quoted. */
export function providerKillCommand(runId: string, adapter: AdapterId): string {
  if (!UUID.test(runId)) throw new Error(`CR2 needs a run id, got ${JSON.stringify(runId)}`);
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `sh -c ${quote(PROVIDER_KILL_SCRIPT)} paperclip-chaos-cr2 ${quote(runId)} ${quote(PROVIDER_PROCESS_PATTERN[adapter])}`;
}

/** What one CR2 kill found and did, per sandbox. */
export interface ProviderKillRecord {
  runId: string | null;
  adapter: AdapterId;
  at: number;
  /** The sandbox whose Runner serves the run, and the PIDs killed there. */
  sandboxId: string | null;
  killedPids: number[];
  /** Per sandbox: the script's exit code and output (3 means no Runner for the run there). */
  attempts: Array<{ sandboxId: string; exitCode: number | null; output: string; error: string | null }>;
  error: string | null;
}

export function killedPidsFromOutput(output: string): number[] {
  const line = /^== killed((?:\s+[0-9]+)+) at /m.exec(output);
  return line ? line[1]!.trim().split(/\s+/).map(Number) : [];
}

/** What CR3 stopped: the Daytona plugin worker and its children, for how long. */
export interface PluginStallRecord {
  workerPid: number | null;
  command: string | null;
  frozenPids: number[];
  frozenAt: number | null;
  thawedAt: number | null;
  error: string | null;
}

/** The Daytona sandbox-provider plugin worker among the server's descendants (a forked `node .../worker`). */
/**
 * CR3: stop the server's Daytona plugin worker and its children for the hold, then continue them. The stall clock
 * starts only once the worker itself is stopped; a worker that is missing or could not be stopped is an error.
 */
export async function runPluginStall(input: {
  serverPid: number; holdMs: number; cancelled: () => boolean; record: (event: string, data: Record<string, unknown>) => void;
  freezer?: Pick<ProcessFreezer, "freeze" | "thaw">; table?: () => ProcessRow[]; sleep?: (ms: number) => Promise<void>;
}): Promise<PluginStallRecord> {
  const stall: PluginStallRecord = { workerPid: null, command: null, frozenPids: [], frozenAt: null, thawedAt: null, error: null };
  const rows = (input.table ?? readProcessTable)();
  const worker = findDaytonaPluginWorker(rows, input.serverPid, root => descendantPids(root, rows));
  if (!worker) return { ...stall, error: "CR3 found no single Daytona plugin worker under the server" };
  stall.workerPid = worker.pid;
  stall.command = worker.command;
  const freezer = input.freezer ?? new ProcessFreezer();
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try {
    stall.frozenPids = freezer.freeze(worker.pid, true);
    if (!stall.frozenPids.includes(worker.pid)) {
      stall.error = `CR3 could not stop the Daytona plugin worker ${worker.pid}`;
      return stall;
    }
    stall.frozenAt = Date.now();
    input.record("plugin_worker_frozen", { pids: stall.frozenPids, holdMs: input.holdMs });
    while (Date.now() - stall.frozenAt < input.holdMs) {
      if (input.cancelled()) { stall.error = "Harness shutdown interrupted the plugin stall"; break; }
      await sleep(Math.min(1_000, input.holdMs - (Date.now() - stall.frozenAt)));
    }
  } finally {
    freezer.thaw();
    if (stall.frozenAt !== null) {
      stall.thawedAt = Date.now();
      input.record("plugin_worker_thawed", { frozenMs: stall.thawedAt - stall.frozenAt });
    }
  }
  return stall;
}

export function findDaytonaPluginWorker(rows: ReadonlyArray<{ pid: number; ppid: number; command: string }>, serverPid: number,
  descendants: (root: number) => number[]): { pid: number; command: string } | null {
  const under = new Set(descendants(serverPid));
  const matches = rows.filter(row => under.has(row.pid) && /daytona/i.test(row.command) && /\bnode\b|\.m?js\b/.test(row.command)
    && !/paperclip-runnerd/.test(row.command));
  // The worker itself, not a child it spawned: its parent is not another match.
  const ids = new Set(matches.map(row => row.pid));
  const roots = matches.filter(row => !ids.has(row.ppid));
  return roots.length === 1 ? { pid: roots[0]!.pid, command: roots[0]!.command.slice(0, 300) } : null;
}

/**
 * After the controller is ready again, staging failed about 40 s later. Capture every this many ms until the
 * window ends or the task rests, so the moment the provider is found dead lands between two captures.
 */
export const CLASS_R_WATCH_INTERVAL_MS = 15_000;
export const CLASS_R_WATCH_WINDOW_MS = 180_000;
/** The capture right before a fault runs while the controller is still up; it must not delay the fault long. */
export const CLASS_R_PRE_FAULT_DEADLINE_MS = 20_000;

/** The labels of one watch series: `<fault>-ready+<seconds>s`. */
export function watchLabels(faultId: string, windowMs = CLASS_R_WATCH_WINDOW_MS, intervalMs = CLASS_R_WATCH_INTERVAL_MS): Array<{ label: string; atMs: number }> {
  const out: Array<{ label: string; atMs: number }> = [];
  for (let at = 0; at <= windowMs; at += intervalMs) out.push({ label: `${faultId}-ready+${Math.round(at / 1000)}s`, atMs: at });
  return out;
}

/** A class R fault's receipt: what the fault itself did, beside the restart fields. */
export interface ClassRRecord {
  kind: ClassRFaultKind;
  redeploy: boolean;
  providerKill?: ProviderKillRecord;
  pluginStall?: PluginStallRecord;
  captures: string[];
}

/**
 * CR2 and CR3 only test something when their fault applied: a provider was killed, or the plugin worker was
 * stopped for the whole stall. A CR task without that fails `class_r_fault_applied`.
 */
export function withClassRCheck<T extends { verdict: "pass" | "fail"; checks: Array<{ name: string; ok: boolean; detail?: string }> }>(
  oracle: T, plan: { taskId: string; fault: string }, faults: ReadonlyArray<{ requestedBy: string; kind: string; classR?: ClassRRecord; error: string | null }>): T {
  if (!isClassRFault(plan.fault)) return oracle;
  const own = faults.filter(fault => fault.requestedBy === plan.taskId && fault.kind === plan.fault);
  let ok = own.length > 0 && own.every(fault => fault.error === null);
  let detail = own.length ? own.map(fault => fault.error ? `error=${fault.error}` : "ok").join(",") : "fault never fired";
  if (plan.fault === "CR2") {
    const kills = own.map(fault => fault.classR?.providerKill);
    ok &&= kills.length > 0 && kills.every(kill => (kill?.killedPids.length ?? 0) > 0 && kill?.error === null);
    detail += `; killed ${kills.map(kill => kill?.killedPids.join("+") || `none(${kill?.error ?? "?"})`).join(",")}`;
  }
  if (plan.fault === "CR3") {
    const stalls = own.map(fault => fault.classR?.pluginStall);
    ok &&= stalls.length > 0 && stalls.every(stall => stall?.frozenAt != null && stall.thawedAt != null);
    detail += `; stalled ${stalls.map(stall => stall?.frozenAt != null && stall.thawedAt != null ? `${stall.thawedAt - stall.frozenAt}ms` : `no(${stall?.error ?? "?"})`).join(",")}`;
  }
  const checks = [...oracle.checks, { name: "class_r_fault_applied", ok, detail }];
  return { ...oracle, checks, verdict: checks.every(check => check.ok) ? "pass" : "fail" };
}
