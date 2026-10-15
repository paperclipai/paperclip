export const REMOTE_RUNNER_RECOVERY_ERROR_CODE = "runner_remote_process_identity_unavailable";

const stages = ["identity_marker", "process_verification"] as const;
const reasons = [
  "marker_missing", "marker_unsafe", "marker_read_failed", "marker_invalid",
  "fingerprint_missing", "process_not_running", "process_identity_changed",
  "fingerprint_unavailable", "process_generation_changed", "probe_timeout",
  "probe_transport_failed", "probe_failed",
] as const;

export interface RemoteRunnerRecoveryDiagnostic {
  stage: typeof stages[number];
  reason: typeof reasons[number];
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
    const { stage, reason } = value as Record<string, unknown>;
    if (!stages.some(candidate => candidate === stage) || !reasons.some(candidate => candidate === reason)) return null;
    return { stage, reason } as RemoteRunnerRecoveryDiagnostic;
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
  'kill -0 "$pid" 2>/dev/null || exit 45',
  'if test -r "/proc/$pid/cmdline"; then command_line=$(tr "\\000" "\\n" < "/proc/$pid/cmdline"); printf "%s\\n" "$command_line" | grep -Fqx -- "--runner-id" || exit 44; printf "%s\\n" "$command_line" | grep -Fqx -- "$expected_runner_id" || exit 44; fi',
].join("; ");

export function remoteRecoveryProbeReason(stage: RemoteRunnerRecoveryDiagnostic["stage"], exitCode: number | null, timedOut: boolean): RemoteRunnerRecoveryDiagnostic["reason"] {
  if (timedOut) return "probe_timeout";
  if (stage === "identity_marker") {
    if (exitCode === 31) return "marker_missing";
    if (exitCode === 32) return "marker_unsafe";
    if (exitCode === 33) return "marker_read_failed";
  } else {
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
