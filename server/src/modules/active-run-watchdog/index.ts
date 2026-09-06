import type { Db } from "@paperclipai/db";
import { createPostgresWatchdogAdapter } from "./adapters/postgres.js";
import { createProcessAdapter } from "./adapters/process.js";
import {
  createBuildRunOutputSilence,
  createFoldSourceResolvedRun,
  createRecordWatchdogDecision,
  createScanSilentActiveRuns,
} from "./application/use-cases.js";

export type ActiveRunWatchdogConfig = {
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  continueRearmMs: number;
};

/**
 * Composes the active-run output watchdog module: the Postgres adapter,
 * the process adapter, and the four use cases. The recovery service holds
 * the only caller.
 */
export function createActiveRunWatchdog(db: Db, config: ActiveRunWatchdogConfig) {
  const postgresAdapter = createPostgresWatchdogAdapter(db);
  const processController = createProcessAdapter();

  const foldSourceResolvedRun = createFoldSourceResolvedRun({
    writer: postgresAdapter,
    processController,
  });

  return {
    buildRunOutputSilence: createBuildRunOutputSilence({
      reader: postgresAdapter,
      suspicionThresholdMs: config.suspicionThresholdMs,
      criticalThresholdMs: config.criticalThresholdMs,
    }),
    scanSilentActiveRuns: createScanSilentActiveRuns({
      reader: postgresAdapter,
      foldSourceResolvedRun,
      suspicionThresholdMs: config.suspicionThresholdMs,
    }),
    recordWatchdogDecision: createRecordWatchdogDecision({
      reader: postgresAdapter,
      writer: postgresAdapter,
      continueRearmMs: config.continueRearmMs,
    }),
  };
}

export type ActiveRunWatchdog = ReturnType<typeof createActiveRunWatchdog>;

export type {
  RunOutputSilenceSummary,
  ScanSilentActiveRunsResult,
  WatchdogDecisionActor,
  WatchdogDecisionRecord,
} from "./application/types.js";
export { WatchdogDecisionApplicationError } from "./application/types.js";
