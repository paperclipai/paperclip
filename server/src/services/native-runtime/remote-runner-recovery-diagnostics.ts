export const REMOTE_RUNNER_RECOVERY_ERROR_CODE = "runner_remote_process_identity_unavailable";

const stages = ["runner_state", "identity_marker", "process_verification"] as const;
const reasons = [
  "marker_missing", "marker_unsafe", "marker_read_failed", "marker_invalid",
  "fingerprint_missing", "process_not_running", "process_identity_changed",
  "fingerprint_unavailable", "process_generation_changed", "probe_timeout",
  "probe_transport_failed", "probe_failed",
  "state_read_failed", "state_invalid",
] as const;

const runnerLifecycles = [
  "connecting", "ready", "backpressure", "reconnecting", "session_opening", "session_open",
  "turn_starting", "turn_active", "running", "suspended", "recoverable_failure", "reconciliation_required",
  "provider_exited", "unrecoverable", "fenced", "failed", "completed", "closed",
  "other", "unavailable",
] as const;

export interface RemoteRunnerRecoveryDiagnostic {
  stage: typeof stages[number];
  reason: typeof reasons[number];
  runnerLifecycle?: typeof runnerLifecycles[number];
  runnerSettled?: boolean;
  /** Present only as `false`: the controller journal proves no turn command was ever issued. */
  providerTurnIssued?: false;
  /** process_not_running: the exited Runner's own recoverable-failure code from its durable state. */
  runnerRecoverableFailure?: string;
  /** process_not_running: the last durable state diagnostics, redacted and bounded. */
  runnerDiagnostics?: string[];
  /** process_not_running: a redacted tail of the Runner's sandbox-local stderr and exit diagnostic files. */
  runnerExitEvidence?: string;
}

/** Bounds for the exit evidence a recovery event carries. */
export const REMOTE_RUNNER_EXIT_EVIDENCE_MAX_CHARS = 4_096;
const RUNNER_DIAGNOSTIC_MAX_CHARS = 500;
const RUNNER_DIAGNOSTIC_COUNT = 4;
const RECOVERABLE_FAILURE_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;

/**
 * Prints a bounded tail of the exited Runner's sandbox-local exit evidence: the
 * bounded exit diagnostic runnerd writes itself (`runnerd.stderr.log`) and its
 * redirected stderr (`runnerd.process-stderr.log`). Each argument is a candidate
 * diagnostics directory, most specific first; the first that holds either file
 * is the one read. Read-only; missing or unsafe files print nothing.
 */
export const REMOTE_RUNNER_EXIT_EVIDENCE_SCRIPT =
  'for directory in "$@"; do test -d "$directory" && test ! -L "$directory" || continue; found=""; ' +
  'for name in runnerd.stderr.log runnerd.process-stderr.log; do file="$directory/$name"; ' +
  'if test -f "$file" && test ! -L "$file"; then found=1; printf "== %s\\n" "$name"; tail -c 2048 -- "$file"; printf "\\n"; fi; done; ' +
  'test -z "$found" || exit 0; done; exit 0';

/** The durable reason an exited Runner recorded, redacted and bounded for a run event. */
export function describeExitedRemoteRunnerReason(state: Record<string, unknown> | null, redact: (text: string) => string):
  Pick<RemoteRunnerRecoveryDiagnostic, "runnerRecoverableFailure" | "runnerDiagnostics"> {
  if (!state) return {};
  const failure = typeof state.recoverableFailure === "string" ? state.recoverableFailure
    : typeof state.recoverable_failure === "string" ? state.recoverable_failure : null;
  const diagnostics = Array.isArray(state.diagnostics)
    ? state.diagnostics.filter((value): value is string => typeof value === "string").slice(-RUNNER_DIAGNOSTIC_COUNT)
      .map(value => redact(value).slice(-RUNNER_DIAGNOSTIC_MAX_CHARS))
    : [];
  return {
    ...(failure && RECOVERABLE_FAILURE_PATTERN.test(failure) ? { runnerRecoverableFailure: failure } : {}),
    ...(diagnostics.length ? { runnerDiagnostics: diagnostics } : {}),
  };
}

/** The tail of the exit evidence script's output, redacted and bounded; null when there is none. */
export function boundRemoteRunnerExitEvidence(output: string, redact: (text: string) => string): string | null {
  // Each file gets its own share of the budget, so a long stderr tail cannot crowd out the exit diagnostic.
  const sections = redact(output).split(/^(?=== runnerd\.)/m).map(section => section.trim()).filter(Boolean);
  if (!sections.length) return null;
  const share = Math.floor(REMOTE_RUNNER_EXIT_EVIDENCE_MAX_CHARS / sections.length) - 1;
  return sections.map(section => {
    if (section.length <= share) return section;
    const header = section.slice(0, section.indexOf("\n") + 1);
    return header + section.slice(-(share - header.length));
  }).join("\n");
}

export function describeExitedRemoteRunner(state: Record<string, unknown>): Pick<RemoteRunnerRecoveryDiagnostic,
  "runnerLifecycle" | "runnerSettled"> {
  const lifecycle = state.lifecycle;
  return {
    runnerLifecycle: typeof lifecycle !== "string" ? "unavailable"
      : runnerLifecycles.find(candidate => candidate === lifecycle && candidate !== "other" && candidate !== "unavailable") ?? "other",
    runnerSettled: Array.isArray(state.outbox) && state.outbox.length === 0 &&
      state.pendingTerminalDelivery == null && state.pendingProviderCleanup == null && state.warmTransition == null,
  };
}

const transportDiagnostics = new WeakMap<object, RemoteRunnerRecoveryDiagnostic>();

export function attachRemoteRunnerRecoveryDiagnostic(error: unknown, diagnostic: RemoteRunnerRecoveryDiagnostic): unknown {
  if (error && typeof error === "object") {
    transportDiagnostics.set(error, diagnostic);
    return error;
  }
  return new RemoteRunnerRecoveryError(diagnostic);
}

export class RemoteRunnerRecoveryError extends Error {
  readonly code = REMOTE_RUNNER_RECOVERY_ERROR_CODE;

  constructor(readonly remoteRunnerRecovery: RemoteRunnerRecoveryDiagnostic) {
    super(REMOTE_RUNNER_RECOVERY_ERROR_CODE);
  }
}

export function readRemoteRunnerRecoveryDiagnostic(value: unknown): RemoteRunnerRecoveryDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  try {
    const { stage, reason, runnerLifecycle, runnerSettled, providerTurnIssued, runnerRecoverableFailure, runnerDiagnostics,
      runnerExitEvidence } = value as Record<string, unknown>;
    if (!stages.some(candidate => candidate === stage) || !reasons.some(candidate => candidate === reason)) return null;
    const diagnostics = Array.isArray(runnerDiagnostics)
      ? runnerDiagnostics.filter((entry): entry is string => typeof entry === "string").slice(-RUNNER_DIAGNOSTIC_COUNT)
        .map(entry => entry.slice(-RUNNER_DIAGNOSTIC_MAX_CHARS))
      : [];
    return {
      stage, reason,
      ...(runnerLifecycles.some(candidate => candidate === runnerLifecycle) ? { runnerLifecycle } : {}),
      ...(typeof runnerSettled === "boolean" ? { runnerSettled } : {}),
      ...(providerTurnIssued === false ? { providerTurnIssued } : {}),
      ...(typeof runnerRecoverableFailure === "string" && RECOVERABLE_FAILURE_PATTERN.test(runnerRecoverableFailure)
        ? { runnerRecoverableFailure } : {}),
      ...(diagnostics.length ? { runnerDiagnostics: diagnostics } : {}),
      ...(typeof runnerExitEvidence === "string" && runnerExitEvidence
        ? { runnerExitEvidence: runnerExitEvidence.slice(-REMOTE_RUNNER_EXIT_EVIDENCE_MAX_CHARS) } : {}),
    } as RemoteRunnerRecoveryDiagnostic;
  } catch {
    return null;
  }
}

export function readRemoteRunnerRecoveryError(error: unknown): RemoteRunnerRecoveryDiagnostic | null {
  let candidate = error;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === "object"; depth++) {
    const transportDiagnostic = transportDiagnostics.get(candidate);
    if (transportDiagnostic) return transportDiagnostic;
    try {
      const record = candidate as Record<string, unknown>;
      if (record.code === REMOTE_RUNNER_RECOVERY_ERROR_CODE) return readRemoteRunnerRecoveryDiagnostic(record.remoteRunnerRecovery);
      candidate = record.cause;
    } catch {
      return null;
    }
  }
  return null;
}

export const REMOTE_RECOVERY_MARKER_READ_SCRIPT =
  'test ! -L "$1" || exit 32; test -f "$1" || exit 31; cat -- "$1" || exit 33';

export const REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT = [
  "set -eu",
  "identity_path=$1; expected_nonce=$2; expected_runner_id=$3; expected_pid=$4",
  'test ! -L "$identity_path" || exit 42',
  'test -f "$identity_path" || exit 41',
  '{ IFS= read -r nonce; IFS= read -r pid; IFS= read -r started_at; IFS= read -r runner_id; } < "$identity_path" || exit 43',
  'test "$nonce" = "$expected_nonce" && test "$runner_id" = "$expected_runner_id" && test "$pid" = "$expected_pid" && test -n "$started_at" || exit 44',
  String.raw`node -e '
const fs = require("node:fs");
const [pid, runnerId, expectedGeneration] = process.argv.slice(1);
if (!/^[1-9][0-9]*$/.test(pid) || !Number.isSafeInteger(Number(pid))) process.exit(44);
function requireLiveProcess() {
  try { process.kill(Number(pid), 0); }
  catch (error) { process.exit(error.code === "ESRCH" ? 45 : 46); }
}
function verifyGeneration() {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const end = stat.lastIndexOf(") ");
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    const ticks = fields[19];
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (end < 0 || !stat.startsWith(pid + " (") || !/^[0-9]+$/.test(ticks || "") || !/^[-a-fA-F0-9]+$/.test(boot)) process.exit(46);
    if ("linux:" + boot + ":" + ticks !== expectedGeneration) process.exit(47);
    if (fields[0] === "Z") process.exit(45);
  } catch (error) {
    if (error.code === "ENOENT") requireLiveProcess();
    process.exit(46);
  }
}
requireLiveProcess();
const commandPath = "/proc/" + pid + "/cmdline";
if (process.platform !== "linux" && !expectedGeneration && !fs.existsSync(commandPath)) process.exit(0);
let args;
try { args = fs.readFileSync(commandPath, "utf8").split("\0"); }
catch (error) {
  requireLiveProcess();
  if (error.code === "ENOENT" && expectedGeneration) verifyGeneration();
  process.exit(46);
}
if (expectedGeneration) verifyGeneration();
if (!args.includes("--runner-id") || !args.includes(runnerId)) {
  requireLiveProcess();
  process.exit(44);
}
' "$pid" "$expected_runner_id"` + ' "${5:-}"',
].join("; ");

export function remoteRecoveryProbeReason(stage: RemoteRunnerRecoveryDiagnostic["stage"], exitCode: number | null, timedOut: boolean): RemoteRunnerRecoveryDiagnostic["reason"] {
  if (timedOut) return "probe_timeout";
  if (stage === "identity_marker") {
    if (exitCode === 31) return "marker_missing";
    if (exitCode === 32) return "marker_unsafe";
    if (exitCode === 33) return "marker_read_failed";
  } else if (stage === "process_verification") {
    if (exitCode === 41) return "marker_missing";
    if (exitCode === 42) return "marker_unsafe";
    if (exitCode === 43) return "marker_read_failed";
    if (exitCode === 44) return "process_identity_changed";
    if (exitCode === 45) return "process_not_running";
    if (exitCode === 46) return "fingerprint_unavailable";
    if (exitCode === 47) return "process_generation_changed";
  }
  return "probe_failed";
}
