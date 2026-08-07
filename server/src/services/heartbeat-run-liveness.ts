import path from "node:path";
import { readObservedProcessIdentity } from "./hot-restart.js";

// The subset of a heartbeat run row needed to decide whether a persisted PID
// still belongs to the ORIGINAL child that the run spawned. The identity fields
// are captured once at spawn (via readObservedProcessIdentity) and persisted so
// that a later server -- after a hot restart, or after losing its in-memory
// child handle -- can prove a live PID is still ours rather than an unrelated
// process that recycled the PID. Mirrors the server-boot identity binding in
// hot-restart.ts (samePostgresIdentity) for the heartbeat run path.
export type RunProcessIdentitySource = {
  processPid: number | null;
  processStartedAtEpochMs: number | null;
  processExecutablePath: string | null;
};

export type RunProcessLivenessReason =
  | "pid_absent"
  | "pid_dead"
  | "identity_absent_legacy"
  | "identity_unreadable"
  | "identity_match"
  | "identity_mismatch";

export type RunProcessLiveness = {
  // The persisted PID currently belongs to (or cannot be proven to differ from)
  // the original run child. When false, the PID is not the run's child.
  alive: boolean;
  // The PID may be terminated as the run's child. False whenever we cannot prove
  // the live PID is ours, so we never kill an unrelated process that recycled it.
  safeToTerminatePid: boolean;
  // A not-alive result means the original child is provably gone (recycled PID or
  // dead PID), so a process-lost retry is correct. When false, a not-alive/other
  // result is unconfirmed and a retry could duplicate side effects against a
  // child that is in fact still ours.
  provablyDead: boolean;
  reason: RunProcessLivenessReason;
};

function normalizeExecutablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export type EvaluateRunProcessLivenessDeps = {
  isProcessAlive: (pid: number | null | undefined) => boolean;
  readObservedProcessIdentity?: typeof readObservedProcessIdentity;
};

export async function evaluateRunProcessLiveness(
  run: RunProcessIdentitySource,
  deps: EvaluateRunProcessLivenessDeps,
): Promise<RunProcessLiveness> {
  const pid = run.processPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { alive: false, safeToTerminatePid: false, provablyDead: true, reason: "pid_absent" };
  }
  if (!deps.isProcessAlive(pid)) {
    return { alive: false, safeToTerminatePid: false, provablyDead: true, reason: "pid_dead" };
  }

  // Legacy rows spawned before identity binding carry no bound identity, so the
  // original child cannot be distinguished from a recycled PID. Preserve the
  // pre-binding PID-only semantics for the rollout transition window only --
  // these rows decay to zero as pre-deploy runs finalize. Documented and
  // deliberately not fail-secure, because marking a still-live legacy child
  // "lost" would feed the process-lost retry and duplicate its side effects.
  const boundEpochMs = run.processStartedAtEpochMs;
  if (typeof boundEpochMs !== "number" || boundEpochMs <= 0) {
    return {
      alive: true,
      safeToTerminatePid: true,
      provablyDead: false,
      reason: "identity_absent_legacy",
    };
  }

  const readIdentity = deps.readObservedProcessIdentity ?? readObservedProcessIdentity;
  let observed: { startedAtEpochMs: number; executablePath: string };
  try {
    observed = await readIdentity(pid);
  } catch {
    // Transient inability to read the live PID's OS identity (e.g. a flaky
    // Get-Process). Do not kill (the PID might be unrelated) and do not declare
    // provably-dead (a retry could double-fire against a child that is still
    // ours). Treat as alive-but-unverified: fail closed without a PID kill.
    return {
      alive: true,
      safeToTerminatePid: false,
      provablyDead: false,
      reason: "identity_unreadable",
    };
  }

  const startedMatches = observed.startedAtEpochMs === boundEpochMs;
  const executableMatches =
    !run.processExecutablePath
    || normalizeExecutablePath(observed.executablePath)
      === normalizeExecutablePath(run.processExecutablePath);
  if (startedMatches && executableMatches) {
    return { alive: true, safeToTerminatePid: true, provablyDead: false, reason: "identity_match" };
  }

  // The PID is alive but its OS creation identity differs from what was bound at
  // spawn: the original child is gone and its PID was recycled by an unrelated
  // process. The run is lost (a retry is correct) and the PID must never be
  // killed -- that is exactly the "terminate an unrelated live process" harm.
  return { alive: false, safeToTerminatePid: false, provablyDead: true, reason: "identity_mismatch" };
}
