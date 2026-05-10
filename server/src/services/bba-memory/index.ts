/**
 * BBA Memory — public entry point.
 *
 * Re-exports the surface that other modules should use:
 *   import { initBbaMemory, startRun, completeRun, ... } from "../services/bba-memory/index.js";
 *
 * Anything that has to touch SQL directly should still go through
 * the repository here, not the underlying better-sqlite3 instance.
 */

export { initBbaMemory, getDb, closeBbaMemory, pruneOldRuns, TRACES_DIR, SCREENSHOTS_DIR } from "./db.js";

export {
  // training sessions
  startTrainingSession,
  completeTrainingSession,
  getTrainingSession,
  listTrainingSessions,
  // runs
  startRun,
  completeRun,
  getRun,
  listRecentRuns,
  listRecentRunsForCompany,
  listRunsForSession,
  getCompanyStatsSummary,
  // selectors
  getSelectorsByPurpose,
  listAllSelectors,
  recordSelectorObservation,
  setSelectorEnabled,
  setSelectorPriority,
  // popups
  recordPopup,
  getPopupReviewQueue,
  listPopupsForRun,
  reviewPopup,
  // failures
  recordFailure,
  listFailuresForRun,
  // stats
  getSuccessStats,
  // idempotency
  getIdempotencyKey,
  putIdempotencyKey,
  // helpers
  safeParseMetaJson,
} from "./repository.js";

export type {
  RunSource,
  RunOutcome,
  SessionStatus,
  TrainingMode,
  TrainingStatus,
  SelectorPurpose,
  SelectorSource,
  PopupAction,
  PopupOutcome,
  ReviewStatus,
  FailureClass,
  FailureStep,
  TrainingSessionRow,
  RunRow,
  SelectorRow,
  SelectorRanked,
  PopupRow,
  FailureRow,
  SuccessStats,
} from "./types.js";

export type { CompanyStatsSummary, IdempotencyRow } from "./repository.js";
