import os from "node:os";

/**
 * RBR-974 — instance-wide agent-run admission control.
 *
 * Background: per-agent `heartbeat.maxConcurrentRuns` caps existed, but nothing
 * summed them. With N agents each allowed 3-5 runs, the instance happily started
 * 27 concurrent agent runs on a 12-core host (measured load average 45.98). Every
 * process on the box — including the Paperclip API server itself — then slowed by
 * the oversubscription factor, runs blew their wall clock, and recovery read the
 * resulting `timed_out` runs as abandoned work and reverted issue status.
 *
 * This module is the admission gate. It is deliberately pure: every input is
 * passed in, so it can be unit-tested without a database, a server, or synthetic
 * host load. `startNextQueuedRunForAgent` consults it before claiming a queued
 * run; when admission is refused the run stays `queued` and the periodic
 * `resumeQueuedRuns` sweep retries it later. Deferral is the backpressure
 * mechanism — we never drop a run, and we never start one we expect to be killed.
 */

/**
 * Load cost of a single agent run, in load-average units.
 *
 * Derived from measurement rather than guessed. On the 12-core reference host:
 * 27 concurrent agent runs produced a sustained 1m load average of 45.98, with a
 * non-agent baseline (API server, embedded postgres, desktop session, browser) of
 * roughly 4. That gives (45.98 - 4) / 27 = 1.55 load units per run — each agent
 * run is its own CLI process plus the verification subprocesses (tsc/vitest/
 * embedded-postgres) our execution contract asks it to spawn.
 */
export const MEASURED_LOAD_PER_AGENT_RUN = 1.55;

/**
 * Fraction of host cores the agent-run pool is allowed to target.
 *
 * The remaining 25% is reserved for the control plane the runs depend on: the
 * Paperclip API server, postgres, and the operator's own session. Reserving a
 * share rather than a fixed core count keeps the formula meaningful on hosts of
 * other sizes.
 */
export const AGENT_RUN_CORE_BUDGET_RATIO = 0.75;

/**
 * Refuse to dispatch when the 1m load average exceeds this multiple of the core
 * count, regardless of how many run slots look free. `12 cores, load 46` must be
 * a refusal: the slot accounting cannot see load contributed by processes we did
 * not start (a stray repo-wide `rg`, a human's build, another worktree's test
 * suite), and starting into that only manufactures another timeout.
 */
export const HOST_LOAD_REFUSAL_RATIO = 1.25;

export const GLOBAL_RUN_CEILING_MIN = 2;
export const GLOBAL_RUN_CEILING_MAX = 16;

export type HostLoadSnapshot = {
  cpuCount: number;
  loadAverage1m: number;
};

export type AdmissionDeferralReason = "global_ceiling" | "host_load" | "agent_cap";

export type AdmissionDecision = {
  /** Number of queued runs that may start right now. 0 means defer. */
  availableSlots: number;
  /** Set when availableSlots is 0. */
  deferralReason: AdmissionDeferralReason | null;
  /** Operator-facing explanation, safe to log. */
  detail: string;
  globalCeiling: number;
  effectiveAgentCap: number;
  runningGlobal: number;
  runningForAgent: number;
};

/**
 * Read host CPU count and 1m load average. Split out so callers can inject a
 * synthetic snapshot in tests.
 */
export function readHostLoadSnapshot(): HostLoadSnapshot {
  const cpuCount = Math.max(1, os.cpus().length);
  const [loadAverage1m] = os.loadavg();
  return {
    cpuCount,
    loadAverage1m: Number.isFinite(loadAverage1m) ? Math.max(0, loadAverage1m) : 0,
  };
}

/**
 * The single instance-wide ceiling on concurrent agent runs, derived from host
 * core count and the measured per-run load cost.
 *
 * On the 12-core reference host: floor(12 * 0.75 / 1.55) = floor(5.8) = 5.
 * Five concurrent runs target a load average of ~4 + 5*1.55 = 11.75 on 12 cores —
 * fully utilised but not oversubscribed, which is the point.
 */
export function resolveGlobalRunCeiling(cpuCount?: number): number {
  const cores = Math.max(1, Math.floor(cpuCount ?? readHostLoadSnapshot().cpuCount));
  const derived = Math.floor((cores * AGENT_RUN_CORE_BUDGET_RATIO) / MEASURED_LOAD_PER_AGENT_RUN);
  return Math.max(GLOBAL_RUN_CEILING_MIN, Math.min(GLOBAL_RUN_CEILING_MAX, derived));
}

/**
 * Per-agent caps are sub-caps: they may restrict an agent below the global
 * ceiling but can never authorise more than it. This is what stops N agents'
 * caps from summing past the instance limit.
 */
export function clampAgentCapToGlobalCeiling(agentCap: number, globalCeiling: number): number {
  const cap = Number.isFinite(agentCap) ? Math.floor(agentCap) : globalCeiling;
  return Math.max(0, Math.min(cap, globalCeiling));
}

/**
 * True when the host is too loaded to start anything new.
 */
export function isHostOverloaded(load: HostLoadSnapshot): boolean {
  const cores = Math.max(1, load.cpuCount);
  return load.loadAverage1m / cores > HOST_LOAD_REFUSAL_RATIO;
}

export function evaluateRunAdmission(input: {
  agentCap: number;
  runningForAgent: number;
  runningGlobal: number;
  load: HostLoadSnapshot;
  /** Test/ops override for the derived ceiling. */
  globalCeilingOverride?: number | null;
}): AdmissionDecision {
  const { agentCap, runningForAgent, runningGlobal, load } = input;
  const globalCeiling = Math.max(
    GLOBAL_RUN_CEILING_MIN,
    Math.floor(input.globalCeilingOverride ?? resolveGlobalRunCeiling(load.cpuCount)),
  );
  const effectiveAgentCap = clampAgentCapToGlobalCeiling(agentCap, globalCeiling);
  const base = { globalCeiling, effectiveAgentCap, runningGlobal, runningForAgent };

  // Load check first: it is the only signal that accounts for CPU pressure we did
  // not create, and it is the difference between "we have a free slot" and "a run
  // started now will survive".
  if (isHostOverloaded(load)) {
    // Forward-progress escape valve. Load is not a signal we fully own: a human's
    // build, another worktree's test suite, or a stray repo-wide `rg` can hold the
    // host above the threshold indefinitely. If we refused purely on load, that
    // external pressure would wedge the whole company with nothing running and
    // nothing able to start — a worse failure than a slow run, and one that no
    // amount of waiting resolves.
    //
    // So when zero runs are live instance-wide, we are demonstrably not the cause
    // of the load, and we admit exactly one run. A single run is the least-doomed
    // option available and the only path to draining the queue; deferring forever
    // is strictly worse. Above zero, ordinary backpressure applies.
    if (runningGlobal <= 0 && effectiveAgentCap > 0) {
      return {
        ...base,
        availableSlots: 1,
        deferralReason: null,
        detail:
          `admitting 1 run despite 1m load ${load.loadAverage1m.toFixed(2)} on ${load.cpuCount} cores: ` +
          `no runs are live instance-wide, so the load is external and deferring would stall all work`,
      };
    }
    return {
      ...base,
      availableSlots: 0,
      deferralReason: "host_load",
      detail:
        `deferring dispatch: 1m load ${load.loadAverage1m.toFixed(2)} on ${load.cpuCount} cores ` +
        `exceeds ${HOST_LOAD_REFUSAL_RATIO}x core count`,
    };
  }

  const globalRemaining = globalCeiling - runningGlobal;
  if (globalRemaining <= 0) {
    return {
      ...base,
      availableSlots: 0,
      deferralReason: "global_ceiling",
      detail: `deferring dispatch: ${runningGlobal} runs already at instance ceiling ${globalCeiling}`,
    };
  }

  const agentRemaining = effectiveAgentCap - runningForAgent;
  if (agentRemaining <= 0) {
    return {
      ...base,
      availableSlots: 0,
      deferralReason: "agent_cap",
      detail: `deferring dispatch: agent at its cap ${effectiveAgentCap} (${runningForAgent} running)`,
    };
  }

  const availableSlots = Math.min(globalRemaining, agentRemaining);
  return {
    ...base,
    availableSlots,
    deferralReason: null,
    detail:
      `admitting up to ${availableSlots} run(s): ${runningGlobal}/${globalCeiling} instance-wide, ` +
      `${runningForAgent}/${effectiveAgentCap} for this agent`,
  };
}
