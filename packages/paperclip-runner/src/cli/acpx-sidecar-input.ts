import { enqueueSerialInput } from "./serial-input-queue.js";

const ACPX_BOOTSTRAP_COMMANDS = new Set(["initialize", "session.open"]);

export function enqueueAcpxSidecarInput(
  pending: Promise<void>,
  operation: () => Promise<void>,
  onError: (error: unknown) => void | Promise<void>,
): Promise<void> {
  return enqueueSerialInput(pending, operation, onError);
}

export function recordAcpxBootstrapFailure(
  current: Error | null,
  command: string,
  error: Error,
): Error | null {
  return current ?? (ACPX_BOOTSTRAP_COMMANDS.has(command) ? error : null);
}

export function acpxBootstrapBlockedError(
  failure: Error | null,
  command: string,
): Error | null {
  return failure
    ? new Error(
        `ACPX provider bootstrap failed before ${command}: ${failure.message}`,
      )
    : null;
}

/**
 * Preserve only stable ACPX/provider error identities across the sidecar
 * boundary. Startup stderr can contain credentials or provider output, so it
 * contributes a closed category and is never copied into the code itself.
 */
export function acpxSidecarErrorCode(error: Error): string {
  const pending: Error[] = [error];
  const observed = new Set<Error>();
  while (pending.length > 0 && observed.size < 16) {
    const current = pending.shift()!;
    if (observed.has(current)) continue;
    observed.add(current);
    const code = directAcpxSidecarErrorCode(current);
    if (code !== null) return code;

    const details = current as Error & Record<string, unknown>;
    if (current instanceof AggregateError) {
      for (const nested of current.errors) {
        if (nested instanceof Error) pending.push(nested);
      }
    }
    if (details.cause instanceof Error) pending.push(details.cause);
  }
  return "acpx_sidecar_command_failed";
}

function directAcpxSidecarErrorCode(error: Error): string | null {
  const details = error as Error & Record<string, unknown>;
  // AcpxOperationalError publishes its presentation category as outputCode;
  // Node/system errors conventionally use code. Accept the ACPX field first
  // while retaining the latter for closed launch failures.
  const outputCode =
    typeof details.outputCode === "string"
      ? details.outputCode
      : typeof details.code === "string"
        ? details.code
        : null;
  const detailCode =
    typeof details.detailCode === "string" ? details.detailCode : null;
  // ACPX output errors may carry both a broad presentation code (for example,
  // RUNTIME) and the stable operational identity that produced it. Preserve
  // the latter across the sidecar boundary; otherwise a provider bootstrap
  // failure is reduced to an unclassified generic runtime rejection.
  const code =
    detailCode !== null &&
    (outputCode === null || GENERIC_ACPX_OUTPUT_CODES.has(outputCode))
      ? detailCode
      : (outputCode ?? detailCode);
  if (code === null) {
    return error.name === "AcpxSessionHandshakeTimeoutError" ||
      error.message === "ACPX session handshake exceeded its admission deadline"
      ? "ACPX_SESSION_HANDSHAKE_TIMEOUT"
      : null;
  }
  if (!STABLE_ACPX_SIDECAR_CODES.has(code)) return null;
  if (code !== "AGENT_STARTUP_FAILED") return code;

  const stderr =
    typeof details.stderrSummary === "string" ? details.stderrSummary : "";
  if (/ERR_ACPX_UNVERIFIED_MODULE/.test(stderr)) {
    return "AGENT_STARTUP_FAILED.UNVERIFIED_MODULE";
  }
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/i.test(stderr)) {
    return "AGENT_STARTUP_FAILED.MODULE_NOT_FOUND";
  }
  if (/\bEACCES\b|permission denied/i.test(stderr)) {
    return "AGENT_STARTUP_FAILED.PERMISSION_DENIED";
  }
  if (/\bENOENT\b|no such file or directory/i.test(stderr)) {
    return "AGENT_STARTUP_FAILED.FILE_NOT_FOUND";
  }
  if (/SyntaxError|unexpected token/i.test(stderr)) {
    return "AGENT_STARTUP_FAILED.SYNTAX_ERROR";
  }
  if (/ERR_INVALID_ARG|invalid argument/i.test(stderr)) {
    return "AGENT_STARTUP_FAILED.INVALID_ARGUMENT";
  }
  if (!stderr.trim()) return "AGENT_STARTUP_FAILED.NO_STDERR";
  if (typeof details.signal === "string" && details.signal) {
    return "AGENT_STARTUP_FAILED.SIGNAL";
  }
  if (
    typeof details.exitCode === "number" &&
    Number.isInteger(details.exitCode) &&
    details.exitCode !== 0
  ) {
    return "AGENT_STARTUP_FAILED.EXIT_NONZERO";
  }
  return "AGENT_STARTUP_FAILED.OTHER";
}

const GENERIC_ACPX_OUTPUT_CODES = new Set([
  "NO_SESSION",
  "TIMEOUT",
  "PERMISSION_DENIED",
  "PERMISSION_PROMPT_UNAVAILABLE",
  "RUNTIME",
  "USAGE",
]);

const STABLE_ACPX_SIDECAR_CODES = new Set([
  "ACP_MODEL_UNSUPPORTED",
  "ACP_SESSION_INIT_FAILED",
  "AGENT_DISCONNECTED",
  "AGENT_STARTUP_FAILED",
  "AGENT_STARTUP_FAILED.EXIT_NONZERO",
  "AGENT_STARTUP_FAILED.FILE_NOT_FOUND",
  "AGENT_STARTUP_FAILED.INVALID_ARGUMENT",
  "AGENT_STARTUP_FAILED.MODULE_NOT_FOUND",
  "AGENT_STARTUP_FAILED.NO_STDERR",
  "AGENT_STARTUP_FAILED.OTHER",
  "AGENT_STARTUP_FAILED.PERMISSION_DENIED",
  "AGENT_STARTUP_FAILED.SIGNAL",
  "AGENT_STARTUP_FAILED.SYNTAX_ERROR",
  "AGENT_STARTUP_FAILED.UNVERIFIED_MODULE",
  "AUTH_REQUIRED",
  "CLAUDE_ACP_SESSION_CREATE_TIMEOUT",
  "SESSION_CONFIG_OPTION_REPLAY_FAILED",
  "SESSION_MODEL_REPLAY_FAILED",
  "SESSION_MODE_REPLAY_FAILED",
  "SESSION_RESUME_REQUIRED",
  "ACPX_EFFECTIVE_MODEL_MISMATCH",
  "ACPX_MODEL_SELECTION_UNAVAILABLE",
  "ACPX_MODEL_STATUS_UNAVAILABLE",
  "ACPX_PERSISTED_SESSION_IDENTITY_MISMATCH",
  "ACPX_PERSISTED_SESSION_MISSING",
  "ACPX_RUNTIME_ADMISSION_VERIFICATION_TIMEOUT",
  "ACPX_SESSION_ENSURE_FAILED",
  "ACPX_SESSION_ENSURE_NON_ERROR",
  "ACPX_SESSION_ENSURE_TYPE_ERROR",
  "ACPX_SESSION_HANDSHAKE_TIMEOUT",
  "ACPX_SIDECAR_STATUS_READ_TIMEOUT",
  ...GENERIC_ACPX_OUTPUT_CODES,
]);
