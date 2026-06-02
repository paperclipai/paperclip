/**
 * Process lifecycle constants
 *
 * Centralized timing constants for process management, graceful shutdown,
 * and recovery logic across the Paperclip server.
 */

/**
 * Grace period (10 minutes) before considering a process slot available.
 * Used in heartbeat to prevent orphaned process pile-up across restarts.
 */
export const NO_PID_GRACE_MS = 10 * 60 * 1000;

/**
 * Time to wait (5 seconds) after SIGTERM before sending SIGKILL.
 * Used in plugin worker shutdown sequence.
 */
export const SIGTERM_GRACE_MS = 5_000;

/**
 * Base backoff delay (60 seconds) for transient continuation recovery retries.
 * Used in recovery service for exponential backoff calculations.
 */
export const CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS = 60_000;
