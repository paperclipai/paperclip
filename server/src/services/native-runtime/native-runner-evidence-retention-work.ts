import { logger } from "../../middleware/logger.js";
import { registerDeadlineWork } from "../deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { nativeHarnessBackupExpirationService, type NativeHarnessBackupExpirationOptions } from "./native-harness-backup-expiration.js";
import { onNativeRunnerEvidence } from "./native-runner-evidence-signal.js";

export function registerNativeRunnerEvidenceRetentionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  db: Parameters<typeof nativeHarnessBackupExpirationService>[0],
  options: NativeHarnessBackupExpirationOptions,
  canRun: () => boolean,
) {
  const service = nativeHarnessBackupExpirationService(db, { ...options, duty: "evidence" });
  let continuation: number | null = null;
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.nativeRunnerEvidenceRetention, {
    retryMs: 30_000, canRun,
    run: async signal => {
      try {
        const result = await service.tick({ shouldContinue: () => !signal.aborted && canRun() });
        if (result.evidenceCandidates > 0 || result.failed > 0) {
          logger.info({ ...result, dryRun: options.dryRun ?? false }, "native runner evidence retention");
        }
        continuation = result.truncated ? Date.now() + 1000 : null;
      } catch (err) {
        continuation = Date.now() + 60 * 60_000;
        logger.warn({ err }, "native runner evidence inspection failed");
      }
    },
    next: async () => continuation ?? service.nextEvidenceAt(),
  });
  const unsubscribe = onNativeRunnerEvidence(at => { service.noteEvidence(at); worker.wake(); });
  return { ...worker, unsubscribe };
}
