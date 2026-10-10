// Linux `oom_score_adj` protection for the Paperclip control plane.
//
// The kernel OOM killer picks the process with the highest `oom_score`, which is
// proportional to RSS. The server is the largest single process in the
// container cgroup — it holds every pooled DB client, every issue thread, and
// every workspace handle in RSS — so with a uniform `oom_score_adj` the kernel
// kills the *control plane* when one agent run leaks memory. That turns a
// single bad run into a full pod restart instead of shedding one disposable
// worker.
//
// `oom_score_adj` is per-process and inherited across `fork()`/`exec()`, so the
// mitigation has two halves:
//
//   1. At startup, try to lower the server's own adjustment so the control
//      plane is the last thing the kernel considers. Lowering needs
//      CAP_SYS_RESOURCE, which an unprivileged container does not have, so this
//      half is best-effort and reports why it did not apply.
//   2. On every spawn, raise the child's adjustment to the configured worker
//      value so disposable agent runs are shed first. Raising is allowed for the
//      process owner without any capability, so this half works in every
//      deployment — which is why it is the load-bearing half.
//
// Both halves are re-applied on every boot and on every spawn, so an OOM
// restart comes back with the same protection. The container runtime sets the
// inherited adjustment before the process starts, so anything done here is
// already after that point.
//
// Security (secret handling): this module reads and writes only a kernel
// scheduling preference. It carries no credential, token, or user data.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The kernel clamps `oom_score_adj` to this inclusive range. */
export const OOM_SCORE_ADJ_MIN = -1000;
export const OOM_SCORE_ADJ_MAX = 1000;

/** Set to `off` or `false` to disable the mitigation entirely. */
export const OOM_PROTECTION_ENV = "PAPERCLIP_OOM_PROTECTION";
/** The adjustment the server asks for at startup. Lowering needs CAP_SYS_RESOURCE. */
export const OOM_SERVER_SCORE_ADJ_ENV = "PAPERCLIP_OOM_SERVER_SCORE_ADJ";
/** The adjustment applied to every spawned agent run. */
export const OOM_WORKER_SCORE_ADJ_ENV = "PAPERCLIP_OOM_WORKER_SCORE_ADJ";

/**
 * The server's default adjustment. `0` is the kernel's neutral value: it keeps
 * the server out of the "preferred victim" band without making it unkillable,
 * which would wedge the pod when the cgroup is over its limit.
 */
export const DEFAULT_SERVER_OOM_SCORE_ADJ = 0;
/**
 * The worker's default adjustment. The maximum makes the kernel prefer any
 * agent run over the control plane, which is the whole point of the mitigation.
 */
export const DEFAULT_WORKER_OOM_SCORE_ADJ = OOM_SCORE_ADJ_MAX;

/** The resolved, clamped policy. */
export interface OomScoreAdjPolicy {
  /** Whether the mitigation is active. */
  enabled: boolean;
  /** The adjustment the server asks for at startup. */
  serverAdj: number;
  /** The adjustment applied to every spawned agent run. */
  workerAdj: number;
  /**
   * Whether the two adjustments actually order the processes. False when the
   * operator asked for a worker value at or below the server value, in which
   * case the kernel has no preference to act on.
   */
  ordered: boolean;
}

/** The outcome of one adjustment attempt. */
export interface OomScoreAdjOutcome {
  /** Whether the write landed. */
  ok: boolean;
  /** The process the adjustment was written to, or null for the current process. */
  pid: number | null;
  /** The adjustment that was requested. */
  requested: number;
  /** The adjustment the process held before the write, or null if unreadable. */
  previous: number | null;
  /** The adjustment the process holds after the write, or null if unreadable. */
  applied: number | null;
  /** A stable machine-readable reason code. */
  reason: OomScoreAdjReason;
  /** The underlying error message, when the write failed. */
  detail?: string;
}

/** Stable reason codes for an adjustment outcome. */
export type OomScoreAdjReason =
  | "applied"
  | "disabled"
  | "unsupported-platform"
  | "proc-unavailable"
  | "lowering-requires-capability"
  | "write-failed";

/**
 * The procfs mount point. Injectable so tests can exercise the write path
 * without touching the real process table.
 */
export const DEFAULT_OOM_SCORE_ADJ_PROC_ROOT = "/proc";

function isLinux(): boolean {
  return process.platform === "linux";
}

/** Clamps a value to the kernel's inclusive `oom_score_adj` range. */
function clampOomScoreAdj(value: number): number {
  return Math.min(OOM_SCORE_ADJ_MAX, Math.max(OOM_SCORE_ADJ_MIN, Math.trunc(value)));
}

/**
 * Parses one adjustment from an environment value. A missing, empty, or
 * non-numeric value falls back to the default, so a typo in an operator's
 * config cannot silently disable the mitigation.
 */
export function parseOomScoreAdj(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clampOomScoreAdj(parsed);
}

function isProtectionDisabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "off" || normalized === "false" || normalized === "0" || normalized === "no";
}

/**
 * Resolves the policy from the environment. The values are clamped to the
 * kernel's range and reported as-is; the caller decides what to do when they
 * do not order the processes.
 */
export function resolveOomScoreAdjPolicy(
  env: NodeJS.ProcessEnv = process.env,
): OomScoreAdjPolicy {
  if (isProtectionDisabled(env[OOM_PROTECTION_ENV])) {
    return {
      enabled: false,
      serverAdj: DEFAULT_SERVER_OOM_SCORE_ADJ,
      workerAdj: DEFAULT_WORKER_OOM_SCORE_ADJ,
      ordered: true,
    };
  }
  const serverAdj = parseOomScoreAdj(env[OOM_SERVER_SCORE_ADJ_ENV], DEFAULT_SERVER_OOM_SCORE_ADJ);
  const workerAdj = parseOomScoreAdj(env[OOM_WORKER_SCORE_ADJ_ENV], DEFAULT_WORKER_OOM_SCORE_ADJ);
  return {
    enabled: true,
    serverAdj,
    workerAdj,
    ordered: workerAdj > serverAdj,
  };
}

function oomScoreAdjPath(procRoot: string, pid: number): string {
  return join(procRoot, String(pid), "oom_score_adj");
}

/**
 * Reads one process's adjustment. Returns null when the value cannot be read,
 * which is the normal case on a non-Linux platform or for a process that has
 * already exited.
 */
export function readOomScoreAdj(
  pid: number = process.pid,
  procRoot: string = DEFAULT_OOM_SCORE_ADJ_PROC_ROOT,
): number | null {
  if (!isLinux()) return null;
  try {
    const raw = readFileSync(oomScoreAdjPath(procRoot, pid), "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeOomScoreAdj(
  pid: number,
  value: number,
  procRoot: string,
): Omit<OomScoreAdjOutcome, "pid" | "requested"> {
  if (!isLinux()) {
    return {
      ok: false,
      previous: null,
      applied: null,
      reason: "unsupported-platform",
    };
  }
  const previous = readOomScoreAdj(pid, procRoot);
  try {
    writeFileSync(oomScoreAdjPath(procRoot, pid), `${value}\n`, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Lowering below the current value needs CAP_SYS_RESOURCE. Raising never
    // does, so this is the only expected failure for the server's own write.
    const requiresCapability =
      previous !== null && value < previous && /permission denied/i.test(detail);
    return {
      ok: false,
      previous,
      applied: previous,
      reason: requiresCapability ? "lowering-requires-capability" : "write-failed",
      detail,
    };
  }
  return {
    ok: true,
    previous,
    applied: readOomScoreAdj(pid, procRoot),
    reason: "applied",
  };
}

/**
 * Applies the server's own adjustment at startup. Best-effort: an unprivileged
 * container cannot lower its own value, and that is not an error — the worker
 * half of the mitigation is what carries the ordering.
 */
export function applyOomScoreAdjToSelf(
  policy: OomScoreAdjPolicy,
  procRoot: string = DEFAULT_OOM_SCORE_ADJ_PROC_ROOT,
): OomScoreAdjOutcome {
  if (!policy.enabled) {
    return {
      ok: false,
      pid: null,
      requested: policy.serverAdj,
      previous: null,
      applied: null,
      reason: "disabled",
    };
  }
  const result = writeOomScoreAdj(process.pid, policy.serverAdj, procRoot);
  return { ...result, pid: null, requested: policy.serverAdj };
}

/**
 * Raises a spawned agent run's adjustment so the kernel prefers it over the
 * control plane. This is the load-bearing half of the mitigation: it needs no
 * capability, and it is re-applied on every spawn, so it survives an OOM
 * restart of the server.
 *
 * The write is best-effort and silent by default. A failure here must never
 * fail a run, so callers get the outcome back and decide whether to log it.
 */
export function applyOomScoreAdjToChild(
  pid: number,
  policy: OomScoreAdjPolicy,
  procRoot: string = DEFAULT_OOM_SCORE_ADJ_PROC_ROOT,
): OomScoreAdjOutcome {
  if (!policy.enabled) {
    return {
      ok: false,
      pid,
      requested: policy.workerAdj,
      previous: null,
      applied: null,
      reason: "disabled",
    };
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      ok: false,
      pid,
      requested: policy.workerAdj,
      previous: null,
      applied: null,
      reason: "proc-unavailable",
    };
  }
  const result = writeOomScoreAdj(pid, policy.workerAdj, procRoot);
  return { ...result, pid, requested: policy.workerAdj };
}

/** The startup summary, for the log line and for tests. */
export interface OomScoreAdjBootstrapSummary {
  policy: OomScoreAdjPolicy;
  self: OomScoreAdjOutcome;
  /** The server's adjustment after the attempt, or null if unreadable. */
  serverAdj: number | null;
  /** Whether the kernel now prefers a worker over the control plane. */
  protected: boolean;
}

/**
 * Applies the server's own adjustment once at startup. Called from the server
 * entrypoint, before any DB connection or HTTP listener exists, so the
 * protection is in place before the first agent run can be spawned.
 */
export function bootstrapOomScoreAdjProtection(
  env: NodeJS.ProcessEnv = process.env,
  procRoot: string = DEFAULT_OOM_SCORE_ADJ_PROC_ROOT,
): OomScoreAdjBootstrapSummary {
  const policy = resolveOomScoreAdjPolicy(env);
  const self = applyOomScoreAdjToSelf(policy, procRoot);
  const serverAdj = readOomScoreAdj(process.pid, procRoot);
  return {
    policy,
    self,
    serverAdj,
    // An unreadable server adjustment cannot be claimed as protected: if
    // /proc is unreachable here, the per-spawn worker write is unreachable too.
    protected:
      policy.enabled &&
      policy.ordered &&
      serverAdj !== null &&
      serverAdj < policy.workerAdj,
  };
}

/**
 * Applies the worker adjustment to a just-spawned child. Returns the outcome
 * so a caller can log the first failure without logging every spawn.
 */
export function protectSpawnedAgentRun(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  procRoot: string = DEFAULT_OOM_SCORE_ADJ_PROC_ROOT,
): OomScoreAdjOutcome {
  return applyOomScoreAdjToChild(pid, resolveOomScoreAdjPolicy(env), procRoot);
}
