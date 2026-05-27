/**
 * Classifies the cause of a process-loss event as either "infrastructure" or "agent".
 *
 * Infrastructure-cause unlocks auto-recovery (§4 of GNO-128 policy).
 * Agent-cause keeps the current behaviour: mark error, require manual CEO review.
 *
 * Four signals (any one is sufficient to classify as infrastructure):
 *   #1  Correlation — ≥1 other agent in the same company lost its process in the same reap batch.
 *   #2  Clean stderr — stderr has output but contains no recognisable agent stack trace (infra-only noise).
 *   #3  OOM / host kill — the process exited with code 137 (SIGKILL from OOM-killer or systemd).
 *   #4  API healthy — the Paperclip API responded normally at classification time.
 */

/** Matches V8 (at …), Python (File "…", line …), and JVM (at pkg.Class.method) stack frames. */
export const STACK_TRACE_PATTERN =
  /^\s+at\s+[\w$./<>]+\s*\(|^\s+at\s+[\w$./<>]+:\d+|^\s+File\s+"[^"]+",\s+line\s+\d+|^\s+at\s+[\w$.]+\([\w$.]+\.java:\d+\)/m;

export type ProcessLossCauseClass = "infrastructure" | "agent";

export interface ProcessLossInput {
  /** The company the failed run belongs to — used for signal #1 correlation check. */
  companyId: string;
  /** stderr captured during the run, if any. */
  stderrExcerpt: string | null | undefined;
  /** Process exit code, if known. */
  exitCode: number | null | undefined;
}

export interface ClassifyProcessLossCauseOptions {
  /**
   * IDs of OTHER runs (different from the current one) that are being reaped in the same
   * batch and belong to the same company. Used for signal #1 (inter-agent correlation).
   */
  coReapedSameCompanyRunIds?: string[];
  /**
   * Signal #4: whether the Paperclip API responded normally at classification time.
   * Derived from the lightweight scheduler health cache — see `makeApiHealthCache`.
   */
  apiHealthy?: boolean;
}

/**
 * Confidence level of the `causeClass` classification.
 *
 * "primary" — the firing signal cannot be forged by the agent process itself:
 *   - Signal #1 (inter-agent correlation): written by the reaper, not the agent.
 *   - "agent" cause: absence of ALL infra signals is itself safe evidence.
 *
 * "weak" — the firing signal is writable by the agent process and therefore
 *   susceptible to spoofing via `process.stderr.write(...)` or `process.exit(137)`:
 *   - Signal #2 (clean stderr)
 *   - Signal #3 (exit code 137)
 *   - Signal #4 (apiHealthy — absence of evidence, not agent-controlled per se,
 *                but paired with weak signals it cannot strengthen confidence)
 *
 * A run with classifyConfidence="weak" and causeClass="infrastructure" should be
 * treated with reduced trust in abuse-detection pipelines. Repeated weak-infra
 * classifications from the same agent within a short window are a heuristic
 * indicator of possible spoofing.
 */
export type ClassifyConfidence = "primary" | "weak";

export interface ProcessLossCauseResult {
  causeClass: ProcessLossCauseClass;
  /** Signal strength of this classification. */
  classifyConfidence: ClassifyConfidence;
  /** Human-readable explanation of which signal(s) fired. */
  reason: string;
}

export function classifyProcessLossCause(
  input: ProcessLossInput,
  options?: ClassifyProcessLossCauseOptions,
): ProcessLossCauseResult {
  // Signal #1 — inter-agent correlation in the same company (PRIMARY — not agent-controllable)
  if (options?.coReapedSameCompanyRunIds && options.coReapedSameCompanyRunIds.length > 0) {
    const peers = options.coReapedSameCompanyRunIds.length;
    return {
      causeClass: "infrastructure",
      classifyConfidence: "primary",
      reason: `infrastructure_cause(signal_1_correlation(peers=${peers}))`,
    };
  }

  const weakSignals: string[] = [];

  // Signal #2 — stderr present but contains no agent stack trace (WEAK — agent-writable)
  if (
    input.stderrExcerpt &&
    input.stderrExcerpt.trim().length > 0 &&
    !STACK_TRACE_PATTERN.test(input.stderrExcerpt)
  ) {
    weakSignals.push("signal_2_clean_stderr");
  }

  // Signal #3 — OOM kill or SIGKILL (exit code 137 = 128 + SIGKILL) (WEAK — agent-writable)
  if (input.exitCode === 137) {
    weakSignals.push("signal_3_oom_kill");
  }

  // Signal #4 — API healthy at classification time (WEAK — absence of evidence)
  if (options?.apiHealthy === true) {
    weakSignals.push("signal_4_api_healthy");
  }

  if (weakSignals.length > 0) {
    return {
      causeClass: "infrastructure",
      classifyConfidence: "weak",
      reason: `infrastructure_cause(${weakSignals.join(",")})`,
    };
  }

  return {
    causeClass: "agent",
    classifyConfidence: "primary",
    reason: "agent_cause(no_infra_signals)",
  };
}

/**
 * Lightweight in-memory health cache for signal #4.
 *
 * Records the timestamp of the last successful scheduler tick. When `reapOrphanedRuns`
 * runs, it calls `markTick()` at the *end* of a successful pass. The next invocation
 * then reads `isHealthy()` to determine whether a recent tick has completed.
 *
 * TTL is 5 s — short enough to be meaningless during normal operation (ticks every
 * 30 s), but long enough to cover the tail of a slow tick without false negatives.
 */
export interface ApiHealthCache {
  markTick(): void;
  isHealthy(): boolean;
}

export function makeApiHealthCache(ttlMs = 5_000): ApiHealthCache {
  let lastTickAt: number | null = null;
  return {
    markTick() {
      lastTickAt = Date.now();
    },
    isHealthy() {
      if (lastTickAt === null) return false;
      return Date.now() - lastTickAt < ttlMs;
    },
  };
}
