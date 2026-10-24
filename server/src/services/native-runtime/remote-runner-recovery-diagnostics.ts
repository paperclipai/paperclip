export const REMOTE_RUNNER_RECOVERY_ERROR_CODE = "runner_remote_process_identity_unavailable";

const stages = ["runner_state", "identity_marker", "process_verification"] as const;
const reasons = [
  "marker_missing", "marker_unsafe", "marker_read_failed", "marker_invalid",
  "fingerprint_missing", "process_not_running", "process_identity_changed",
  "fingerprint_unavailable", "process_generation_changed", "probe_timeout",
  "probe_transport_failed", "probe_failed",
  "state_read_failed", "state_invalid",
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

function remoteRecoveryGenerationCheck(zombieOnly: boolean) {
  return `node -e '
const fs = require("node:fs");
const [pid, expected] = process.argv.slice(1);
try {
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  const end = stat.lastIndexOf(") ");
  if (end < 0 || !stat.startsWith(pid + " (")) process.exit(46);
  const fields = stat.slice(end + 2).trim().split(/\\s+/);
  if (${zombieOnly} && fields[0] !== "Z") process.exit(44);
  const ticks = fields[19];
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!ticks || !/^[0-9]+$/.test(ticks) || !boot) process.exit(46);
  if ("linux:" + boot + ":" + ticks !== expected) process.exit(47);
  process.exit(fields[0] === "Z" ? 45 : 0);
} catch (error) {
  if (error && error.code === "ENOENT") {
    try { process.kill(Number(pid), 0); }
    catch (probeError) {
      if (probeError && probeError.code === "ESRCH") process.exit(45);
    }
  }
  process.exit(46);
}
' "$pid" "\${5:-}"`;
}

const REMOTE_RECOVERY_ZOMBIE_CHECK_SCRIPT = remoteRecoveryGenerationCheck(true);

export const REMOTE_RECOVERY_PROCESS_FINGERPRINT_CHECK_SCRIPT = remoteRecoveryGenerationCheck(false);

const REMOTE_RECOVERY_LIVENESS_CHECK_SCRIPT = `node -e '
const pid = process.argv[1];
try { process.kill(Number(pid), 0); }
catch (error) { process.exit(error && error.code === "ESRCH" ? 45 : 46); }
' "$pid"`;

export const REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT = [
  "set -eu",
  "identity_path=$1; expected_nonce=$2; expected_runner_id=$3; expected_pid=$4",
  'test ! -L "$identity_path" || exit 42',
  'test -f "$identity_path" || exit 41',
  '{ IFS= read -r nonce; IFS= read -r pid; IFS= read -r started_at; IFS= read -r runner_id; } < "$identity_path" || exit 43',
  'test "$nonce" = "$expected_nonce" && test "$runner_id" = "$expected_runner_id" && test "$pid" = "$expected_pid" && test -n "$started_at" || exit 44',
  REMOTE_RECOVERY_LIVENESS_CHECK_SCRIPT,
  'if test -r "/proc/$pid/cmdline"; then if command_line=$(tr "\\000" "\\n" < "/proc/$pid/cmdline"); then :; else ' + REMOTE_RECOVERY_LIVENESS_CHECK_SCRIPT + '; exit 46; fi; if ! printf "%s\\n" "$command_line" | grep -Fqx -- "--runner-id" || ! printf "%s\\n" "$command_line" | grep -Fqx -- "$expected_runner_id"; then ' + REMOTE_RECOVERY_LIVENESS_CHECK_SCRIPT + '; test -n "${5:-}" || exit 44; ' + REMOTE_RECOVERY_ZOMBIE_CHECK_SCRIPT + '; exit 44; fi; fi',
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
