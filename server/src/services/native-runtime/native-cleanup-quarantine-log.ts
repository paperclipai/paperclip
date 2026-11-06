import { onNativeSessionCleanupQuarantined } from "../../vendor/paperclip-runner/index.js";

type QuarantineLogger = { warn: (details: Record<string, unknown>, message: string) => void };

/**
 * Log every native session cleanup quarantine when the runner creates it or
 * escalates it to operator recovery. A later admission refusal can then be
 * traced to its owning session and close failure.
 */
export function logNativeCleanupQuarantines(logger: QuarantineLogger): () => void {
  return onNativeSessionCleanupQuarantined((quarantine) => {
    logger.warn({ ...quarantine }, quarantine.operatorRecoveryRequired
      ? "native session cleanup quarantined; operator recovery required"
      : "native session cleanup quarantined; automatic close recovery scheduled");
  });
}
