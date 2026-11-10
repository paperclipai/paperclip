/**
 * Repeated restarts (RR1–RR3): a restart that lands while the server is still recovering from the
 * previous one, as in a deploy loop. Each RR fault starts as a K1 (SIGKILL the server tree, start a
 * replacement at once). Then, after each planned gap from the moment the replacement reports
 * healthy, it stops the replacement again and starts another one:
 *
 * - RR1 double crash: one more SIGKILL.
 * - RR2 crash, then graceful: one SIGTERM (as K2).
 * - RR3 crash loop: 3–4 SIGKILLs in all, then the last replacement stays up.
 *
 * The whole sequence is one fault receipt, so the grader sees one fault window from the first kill
 * to the last replacement's ready. Planning, option parsing and the step loop live here with no
 * process code, so they are unit-tested; the supervisor supplies the process hooks.
 */
import type { WaveOptions } from "./types.js";

export const REPEATED_RESTART_KINDS = ["RR1", "RR2", "RR3"] as const;
export type RepeatedRestartKind = (typeof REPEATED_RESTART_KINDS)[number];

export function isRepeatedRestartFault(kind: string): kind is RepeatedRestartKind {
  return (REPEATED_RESTART_KINDS as readonly string[]).includes(kind);
}

/** One restart after the first kill: wait `gapMs` from the previous replacement's health, then stop it with `signal`. */
export interface RestartStep { signal: "SIGKILL" | "SIGTERM"; gapMs: number }

/** Default gaps, from health to the next stop: inside the recovery window (RR1, RR2), or a loop of deploys (RR3). */
export const RR_GAP_RANGE_MS: Record<RepeatedRestartKind, readonly [number, number]> = {
  RR1: [3_000, 20_000],
  RR2: [3_000, 20_000],
  RR3: [10_000, 30_000],
};

/** RR3: how many kills in all, the first one included. */
export const RR3_KILL_RANGE: readonly [number, number] = [3, 4];

/** The seeded restarts that follow the first kill. `gapRangeMs` (`--rr-gap-seconds`) replaces the default gaps. */
export function planRestartSteps(kind: RepeatedRestartKind, int: (min: number, max: number) => number,
  gapRangeMs?: readonly [number, number]): RestartStep[] {
  const range = gapRangeMs ?? RR_GAP_RANGE_MS[kind];
  if (kind === "RR1") return [{ signal: "SIGKILL", gapMs: int(...range) }];
  if (kind === "RR2") return [{ signal: "SIGTERM", gapMs: int(...range) }];
  const kills = int(...RR3_KILL_RANGE);
  const steps: RestartStep[] = [];
  for (let index = 1; index < kills; index += 1) steps.push({ signal: "SIGKILL", gapMs: int(...range) });
  return steps;
}

const MIN_GAP_SECONDS = 1;
const MAX_GAP_SECONDS = 300;

/** `--rr-gap-seconds <n>` or `<min>-<max>` (1–300 s): the gap from a replacement's health to the next stop. */
export function parseRepeatedRestartOptions(options: Pick<WaveOptions, "faults" | "stormMinutes">,
  rawGapSeconds: string | undefined): Pick<WaveOptions, "rrGapMs"> {
  const repeated = options.faults.some(isRepeatedRestartFault);
  if (rawGapSeconds !== undefined && !repeated) throw new Error("--rr-gap-seconds sets the RR restart gap; add RR1, RR2 or RR3 to --faults");
  if (!repeated) return {};
  // A storm fault carries no planned restart steps, and a storm already restarts again and again.
  if (options.stormMinutes) throw new Error("Repeated restarts (RR*) are planned per task; do not combine them with --storm-minutes");
  if (rawGapSeconds === undefined) return {};
  const match = /^([0-9]+)(?:-([0-9]+))?$/.exec(rawGapSeconds.trim());
  if (!match) throw new Error("--rr-gap-seconds takes <seconds> or <min>-<max> seconds");
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (min < MIN_GAP_SECONDS || max > MAX_GAP_SECONDS || max < min) {
    throw new Error(`--rr-gap-seconds must be between ${MIN_GAP_SECONDS} and ${MAX_GAP_SECONDS} seconds, min not above max`);
  }
  return { rrGapMs: [min * 1000, max * 1000] };
}

/** One stop and replacement in the sequence; index 0 is the first (K1) kill. */
export interface RepeatedRestartEntry {
  index: number;
  signal: "SIGKILL" | "SIGTERM";
  /** Planned wait from the previous replacement's health; null for the first kill. */
  gapMs: number | null;
  pid: number | null;
  /** `/api/ready` status just before the stop: `recovering` means the stop landed inside recovery. */
  phaseAtStop: string | null;
  stopAt: number;
  stoppedAt: number | null;
  restartedAt: number | null;
  replacementPid: number | null;
  healthyAt: number | null;
}

export interface RepeatedRestartRecord {
  kind: RepeatedRestartKind;
  planned: RestartStep[];
  restarts: RepeatedRestartEntry[];
  /** `<wave>/repeated-restarts/<faultId>.json`. */
  evidencePath?: string;
}

/**
 * The record of an RR fault, built before its first kill: the planned steps and the first (K1) kill. A
 * first restart that fails still leaves them in the receipt, so a replay reuses the same gaps.
 * Absent planned steps (a fault fired outside a planned task) are drawn with `int`.
 */
export function newRepeatedRestartRecord(input: { kind: RepeatedRestartKind; planned: readonly RestartStep[] | undefined;
  firstPid: number | null; startedAt: number; evidencePath: string; int: (min: number, max: number) => number }): RepeatedRestartRecord {
  const steps = input.planned?.length ? input.planned : planRestartSteps(input.kind, input.int);
  return { kind: input.kind, planned: steps.map(step => ({ ...step })), restarts: [{ index: 0, signal: "SIGKILL", gapMs: null,
    pid: input.firstPid, phaseAtStop: "ready", stopAt: input.startedAt, stoppedAt: null, restartedAt: null, replacementPid: null, healthyAt: null }],
    evidencePath: input.evidencePath };
}

/** Fills the first kill's times from the receipt, whether its replacement became healthy or the fault failed. */
export function recordFirstRestart(record: RepeatedRestartRecord, receipt: { stoppedAt: number | null; restartedAt: number | null;
  healthyAt: number | null }, replacementPid: number | null): void {
  const first = record.restarts[0]!;
  first.stoppedAt ??= receipt.stoppedAt;
  first.restartedAt ??= receipt.restartedAt;
  first.healthyAt ??= receipt.healthyAt;
  first.replacementPid ??= replacementPid;
}

export interface RepeatedRestartHooks<P> {
  now(): number;
  sleep(ms: number): Promise<void>;
  cancelled(): boolean;
  pidOf(server: P): number | null;
  /** The server's exit status once it has exited on its own, else null. */
  exitStatus(server: P): { code: number | null; signal: string | null } | null;
  readPhase(): Promise<string>;
  /** Stop the server with `signal` and wait until it no longer answers health checks. */
  stop(server: P, signal: "SIGKILL" | "SIGTERM"): Promise<void>;
  start(): Promise<P>;
  /** Resolves with the time the replacement reported healthy. */
  waitHealthy(server: P): Promise<number>;
  onEntry?(entry: RepeatedRestartEntry, stage: "stopping" | "healthy"): void;
}

/**
 * Runs the planned restarts after the first kill's replacement reported healthy at `healthyAt`.
 * Each gap runs from the previous replacement's health. Every entry is pushed to `record.restarts`
 * before its stop, so a failure part way still leaves the evidence of what fired.
 */
export async function runRepeatedRestarts<P>(input: {
  record: RepeatedRestartRecord;
  steps: readonly RestartStep[];
  server: P;
  healthyAt: number;
  hooks: RepeatedRestartHooks<P>;
}): Promise<{ server: P; healthyAt: number }> {
  const { record, steps, hooks } = input;
  let server = input.server;
  let healthyAt = input.healthyAt;
  for (const step of steps) {
    const index = record.restarts.length;
    const wait = healthyAt + step.gapMs - hooks.now();
    if (wait > 0) await hooks.sleep(wait);
    if (hooks.cancelled()) throw new Error(`Harness shutdown interrupted repeated restart ${index}`);
    const exited = hooks.exitStatus(server);
    if (exited) throw new Error(`Paperclip server exited on its own before repeated restart ${index} (code=${exited.code} signal=${exited.signal})`);
    const phaseAtStop = await hooks.readPhase();
    const entry: RepeatedRestartEntry = { index, signal: step.signal, gapMs: step.gapMs, pid: hooks.pidOf(server), phaseAtStop,
      stopAt: hooks.now(), stoppedAt: null, restartedAt: null, replacementPid: null, healthyAt: null };
    record.restarts.push(entry);
    hooks.onEntry?.(entry, "stopping");
    await hooks.stop(server, step.signal);
    entry.stoppedAt = hooks.now();
    if (hooks.cancelled()) throw new Error(`Harness shutdown interrupted repeated restart ${index}`);
    entry.restartedAt = hooks.now();
    server = await hooks.start();
    entry.replacementPid = hooks.pidOf(server);
    healthyAt = await hooks.waitHealthy(server);
    entry.healthyAt = healthyAt;
    hooks.onEntry?.(entry, "healthy");
  }
  return { server, healthyAt };
}
