/**
 * Named crash points (durable ownership plan, "Testing: enumerate crash points").
 *
 * `crashPoint(name)` marks a durable write boundary: the gap between two durable
 * writes, or between an outside effect and the record of its outcome. A restart
 * that lands in that gap leaves an in-progress record owned by a dead process.
 * The crash-point suite (`pnpm crash-points`) kills the control plane at each
 * named gap on purpose instead of hoping random chaos timing finds it.
 *
 * Arming (test mode only):
 *
 *   PAPERCLIP_CRASH_POINT=<name>[:<nth>]        SIGKILL this process at the nth hit (default 1)
 *   PAPERCLIP_CRASH_POINT_RECEIPT=<file>        optional; one JSON line is appended before the kill
 *   PAPERCLIP_CRASH_POINT_GATE=<file>           optional; hits before this file exists are not counted,
 *                                               so setup work (seeding, probes) cannot fire the point
 *
 * Runtime arming (one booted server, many points), instead of PAPERCLIP_CRASH_POINT:
 *
 *   PAPERCLIP_CRASH_POINT_CONTROL=<file>        each hit reads "<token> <name>[:<nth>] [fail]" from the file;
 *                                               no file or an empty one means disarmed. Hits count per
 *                                               token, so writing a new token re-arms with a fresh count.
 *
 * Fail mode (control file only): a trailing `fail` makes the nth hit throw instead of
 * killing the process, once. An optional `pid=<n>` binds a line to one process, so a
 * server started earlier (still draining) never counts its hits. The call site may name the error its real step throws
 * (`crashPoint(name, { fail: () => conflict("...") })`); otherwise it throws
 * `CrashPointInjectedFailure`. The restart-chaos harness uses it to fail the Nth
 * attempt of a recovery step (`--fail-recovery-step`), so recovery chains are exercised.
 *
 * The variable is read once, when this module is first imported. It is ignored
 * when `NODE_ENV=production`, and an unknown name throws at import so a typo
 * cannot silently arm nothing. Disarmed, `crashPoint` is a single comparison
 * against a module constant (see crash-points.test.ts for the cost check).
 *
 * In-process tests use `armCrashPointForTest`, which throws `CrashPointReached`
 * at the hit instead of killing the test runner. A throw still runs `finally`
 * blocks and rejects the caller's promise, so it only approximates a crash: a
 * test that needs real process death runs the suite instead.
 *
 * This is test instrumentation, not Telemetry or Observability (rules/data-paths.mdc):
 * nothing is recorded or sent anywhere unless a test arms a point.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { CRASH_POINTS, isCrashPointName, type CrashPointName } from "./crash-point-registry.js";

export { CRASH_POINTS, CRASH_POINT_NAME_PATTERN, isCrashPointName } from "./crash-point-registry.js";
export type { CrashPointDefinition, CrashPointInvariant, CrashPointName } from "./crash-point-registry.js";

export const CRASH_POINT_ENV = "PAPERCLIP_CRASH_POINT";
export const CRASH_POINT_RECEIPT_ENV = "PAPERCLIP_CRASH_POINT_RECEIPT";
export const CRASH_POINT_GATE_ENV = "PAPERCLIP_CRASH_POINT_GATE";
export const CRASH_POINT_CONTROL_ENV = "PAPERCLIP_CRASH_POINT_CONTROL";
/** Printed to stderr just before the kill; the suite greps server logs for it. */
export const CRASH_POINT_LOG_PREFIX = "[crash-point]";

export type CrashPointSpec = { name: CrashPointName; nth: number };
/** `kill` (default) SIGKILLs the process at the hit; `fail` throws once (control file only). */
export type CrashPointMode = "kill" | "fail";
/** What the call site's real step throws when it fails; used in fail mode. */
export type CrashPointOptions = { fail?: () => Error };

export type CrashPointReceipt = {
  point: CrashPointName;
  hit: number;
  pid: number;
  at: string;
  /** Runtime arming only: the control file token the hit counted under. */
  token?: string;
  /** Present for fail mode: the hit threw instead of killing the process. */
  mode?: "fail";
};

/** Thrown at a point armed in fail mode whose call site names no error of its own. */
export class CrashPointInjectedFailure extends Error {
  constructor(readonly point: CrashPointName, readonly hit: number) {
    super(`injected failure at ${point} (hit ${hit})`);
    this.name = "CrashPointInjectedFailure";
  }
}

/** Thrown by a point armed with `armCrashPointForTest`. */
export class CrashPointReached extends Error {
  constructor(readonly point: CrashPointName, readonly hit: number) {
    super(`crash point ${point} reached (hit ${hit})`);
    this.name = "CrashPointReached";
  }
}

/** Parses `<name>[:<nth>]`. Returns null for an empty value; throws on a bad one. */
export function parseCrashPointSpec(raw: string | undefined): CrashPointSpec | null {
  const value = raw?.trim();
  if (!value) return null;
  const separator = value.lastIndexOf(":");
  const name = separator === -1 ? value : value.slice(0, separator);
  const nthText = separator === -1 ? "1" : value.slice(separator + 1);
  if (!/^[1-9]\d{0,5}$/.test(nthText)) {
    throw new Error(`${CRASH_POINT_ENV}=${value}: the hit count after ':' must be a positive integer`);
  }
  if (!isCrashPointName(name)) {
    throw new Error(`${CRASH_POINT_ENV}=${value}: unknown crash point "${name}" (see packages/shared/src/crash-point-registry.ts)`);
  }
  return { name, nth: Number(nthText) };
}

type Armed = {
  spec: CrashPointSpec;
  hits: number;
  mode: "kill" | "throw" | "fail";
  receiptPath: string | null;
  /** Hits count only once this file exists; null when ungated. */
  gatePath: string | null;
  /** Runtime arming: the control file read at each hit; null for a fixed spec. */
  controlPath?: string | null;
  token?: string | null;
};

/** Parses a control file line, "<token> <name>[:<nth>] [fail] [pid=<n>]"; null when empty or malformed. */
export function parseCrashPointControl(text: string): { token: string; spec: CrashPointSpec; mode: CrashPointMode; pid?: number } | null {
  const [token, raw, ...rest] = text.trim().split(/\s+/);
  if (!token || !raw || rest.length > 2) return null;
  let mode: CrashPointMode = "kill";
  let pid: number | undefined;
  for (const option of rest) {
    const match = /^pid=([1-9][0-9]{0,9})$/.exec(option);
    if (option === "fail" && mode === "kill") mode = "fail";
    else if (match && pid === undefined) pid = Number(match[1]);
    else return null;
  }
  try {
    const spec = parseCrashPointSpec(raw);
    return spec ? { token, spec, mode, ...(pid !== undefined ? { pid } : {}) } : null;
  } catch {
    return null;
  }
}

function armFromEnvironment(): Armed | null {
  const env = typeof process === "undefined" ? undefined : process.env;
  if (!env || env.NODE_ENV === "production") return null;
  const controlPath = env[CRASH_POINT_CONTROL_ENV]?.trim();
  if (controlPath) {
    process.stderr.write(`${CRASH_POINT_LOG_PREFIX} runtime arming from ${controlPath} pid=${process.pid}\n`);
    // The spec is a placeholder; each hit reads the real one from the control file.
    return { spec: { name: "" as CrashPointName, nth: 1 }, hits: 0, mode: "kill",
      receiptPath: env[CRASH_POINT_RECEIPT_ENV]?.trim() || null, gatePath: null, controlPath, token: null };
  }
  const spec = parseCrashPointSpec(env[CRASH_POINT_ENV]);
  if (!spec) return null;
  process.stderr.write(`${CRASH_POINT_LOG_PREFIX} armed ${spec.name}:${spec.nth} pid=${process.pid}\n`);
  return {
    spec, hits: 0, mode: "kill",
    receiptPath: env[CRASH_POINT_RECEIPT_ENV]?.trim() || null,
    gatePath: env[CRASH_POINT_GATE_ENV]?.trim() || null,
  };
}

let armed: Armed | null = armFromEnvironment();

/**
 * Marks a durable write boundary. Disarmed (always in production) it returns
 * immediately. Armed for this name, the nth hit kills the process with SIGKILL
 * (or throws `CrashPointReached` under `armCrashPointForTest`).
 */
export function crashPoint(name: CrashPointName, options?: CrashPointOptions): void {
  if (armed === null) return;
  if (armed.controlPath) {
    if (!readControl(armed)) return;
  }
  if (armed.spec.name !== name) return;
  reach(armed, options);
}

/** Runtime arming: loads the control file's spec; a new token resets the count. */
function readControl(current: Armed): boolean {
  let text: string;
  try { text = readFileSync(current.controlPath!, "utf8"); } catch { return false; }
  const control = parseCrashPointControl(text);
  if (!control) return false;
  // A line bound to another process is disarmed here.
  if (control.pid !== undefined && control.pid !== process.pid) return false;
  if (control.token !== current.token) {
    current.token = control.token;
    current.spec = control.spec;
    current.mode = control.mode;
    current.hits = 0;
  }
  return true;
}

function reach(current: Armed, options?: CrashPointOptions): void {
  if (current.gatePath !== null) {
    if (!existsSync(current.gatePath)) return;
    current.gatePath = null;
  }
  current.hits += 1;
  if (current.hits !== current.spec.nth) return;
  if (current.mode === "throw") throw new CrashPointReached(current.spec.name, current.hits);
  const receipt: CrashPointReceipt = {
    point: current.spec.name, hit: current.hits, pid: process.pid, at: new Date().toISOString(),
    ...(current.token ? { token: current.token } : {}),
    ...(current.mode === "fail" ? { mode: "fail" as const } : {}),
  };
  if (current.receiptPath) {
    try { appendFileSync(current.receiptPath, `${JSON.stringify(receipt)}\n`); } catch { /* the log line below still records it */ }
  }
  if (current.mode === "fail") {
    try { process.stderr.write(`${CRASH_POINT_LOG_PREFIX} FAIL ${JSON.stringify(receipt)}\n`); } catch { /* ignore */ }
    throw options?.fail?.() ?? new CrashPointInjectedFailure(current.spec.name, current.hits);
  }
  try { process.stderr.write(`${CRASH_POINT_LOG_PREFIX} SIGKILL ${JSON.stringify(receipt)}\n`); } catch { /* ignore */ }
  process.kill(process.pid, "SIGKILL");
}

/**
 * Arms one point inside a test process: the nth hit throws `CrashPointReached`.
 * Returns a disarm function; call it in `afterEach`. Replaces any armed point.
 */
export function armCrashPointForTest(spec: string | CrashPointSpec): () => void {
  // One parser for both forms, so an object with a bad name or count is refused
  // instead of arming a point that can never fire.
  const parsed = parseCrashPointSpec(typeof spec === "string" ? spec : `${spec.name}:${spec.nth}`);
  if (!parsed) throw new Error("armCrashPointForTest needs a crash point name");
  const previous = armed;
  const current: Armed = { spec: parsed, hits: 0, mode: "throw", receiptPath: null, gatePath: null };
  armed = current;
  return () => { if (armed === current) armed = previous; };
}

/** The armed point and its hit count so far, or null. For tests and diagnostics. */
export function armedCrashPoint(): { name: CrashPointName; nth: number; hits: number } | null {
  return armed && armed.spec.name ? { name: armed.spec.name, nth: armed.spec.nth, hits: armed.hits } : null;
}
