import type { Db } from "@paperclipai/db";
import { loadStorageConfig, type StorageConfig } from "../storage/config.js";
import { logger } from "../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { registerIdleLocalWorkProbe, type IdleLocalWork } from "./idle-local-work.js";
import { migrateRunEvidence } from "./run-evidence-migration.js";

export function registerRunEvidenceMigrationWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  canRun: () => boolean,
  storage: Pick<StorageConfig, "storageProvider"> = loadStorageConfig(),
) {
  if (storage.storageProvider !== "s3") return null;
  let runCursor: string | undefined, traceCursor: string | undefined;
  let logsDone = false,
    tracesDone = false,
    blocked = 0,
    migrated = 0;
  let retryMs = 5 * 60_000;
  let next: number | null = Date.now();
  let pending: IdleLocalWork = "unknown";
  const unregister = registerIdleLocalWorkProbe(() => pending);
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.runEvidenceMigration, {
    canRun,
    retryMs: 30_000,
    continuationMs: 1_000,
    async run(signal) {
      if (next === null) return;
      const result = await migrateRunEvidence(db, {
        apply: true,
        limit: 1,
        afterRunId: runCursor,
        afterTraceId: traceCursor,
        kinds: [...(logsDone ? [] : ["log" as const]), ...(tracesDone ? [] : ["trace" as const])],
        signal,
      });
      signal.throwIfAborted();
      for (const item of result.items) {
        if (item.state === "blocked") {
          blocked++;
          logger.warn(
            { kind: item.kind, id: item.id, reason: item.reason },
            "Run evidence migration deferred; source storage is still required",
          );
        } else if (item.state === "migrated") migrated++;
      }
      if (!logsDone) {
        runCursor = result.nextRunId;
        logsDone = runCursor === undefined;
      }
      if (!tracesDone) {
        traceCursor = result.nextTraceId;
        tracesDone = traceCursor === undefined;
      }
      pending = "present";
      next = Date.now() + 1_000;
      if (logsDone && tracesDone) {
        logger.info(
          { migrated, blocked },
          blocked
            ? "Run evidence migration will retry unresolved history; keep source storage"
            : "Run evidence migration complete",
        );
        next = blocked ? Date.now() + retryMs : null;
        pending = blocked ? "present" : "none";
        retryMs = Math.min(retryMs * 2, 30 * 60_000);
        runCursor = traceCursor = undefined;
        logsDone = tracesDone = false;
        blocked = migrated = 0;
      }
    },
    next: async () => next,
  });
  return {
    ...worker,
    stop: async () => {
      await worker.stop();
      unregister();
    },
  };
}
