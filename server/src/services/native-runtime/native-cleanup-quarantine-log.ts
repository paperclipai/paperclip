import { onNativeSessionCleanupQuarantined } from "../../vendor/paperclip-runner/index.js";

type QuarantineLogger = { warn: (details: Record<string, unknown>, message: string) => void };

let installed: { logger: QuarantineLogger; unsubscribe: () => void } | null = null;

/**
 * Log every native session cleanup quarantine when the runner creates it or
 * escalates it to operator recovery, so a later admission refusal can be
 * traced to its owning session and close failure. The subscription is
 * process-wide and installed once: native closes can still fail during
 * shutdown after the HTTP server has closed.
 */
export function logNativeCleanupQuarantines(logger: QuarantineLogger): () => void {
  if (installed?.logger === logger) return installed.unsubscribe;
  installed?.unsubscribe();
  const unsubscribe = onNativeSessionCleanupQuarantined((quarantine) => {
    logger.warn({ ...quarantine }, quarantine.operatorRecoveryRequired
      ? "native session cleanup quarantined; operator recovery required"
      : "native session cleanup quarantined; automatic close recovery scheduled");
  });
  installed = { logger, unsubscribe: () => { unsubscribe(); installed = null; } };
  return installed.unsubscribe;
}
