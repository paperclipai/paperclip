/**
 * Shared active-run output silence thresholds. The recovery service feeds these
 * into the watchdog module and the issue binding guards reuse the critical
 * threshold for same-assignee supersede of critically-silent holding runs, so
 * both subsystems agree on one configured source instead of duplicating magic
 * numbers.
 */
export const ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS = 30 * 60 * 1000;
