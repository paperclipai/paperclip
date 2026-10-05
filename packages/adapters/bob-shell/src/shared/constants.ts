/**
 * Shared constants for the IBM Bob Shell adapter.
 */

/** Adapter type identifier registered with Paperclip. */
export const ADAPTER_TYPE = "bob_shell";

/** Human-readable label shown in the Paperclip UI. */
export const ADAPTER_LABEL = "IBM Bob";

/** Default CLI binary name. */
export const BOB_CLI = "bob";

/** Default timeout for a single execution run (seconds). */
export const DEFAULT_TIMEOUT_SEC = 1800;

/** Grace period after SIGTERM before SIGKILL (seconds). */
export const DEFAULT_GRACE_SEC = 15;

/** Default max cost in Bobcoins per run (0 = no limit). */
export const DEFAULT_MAX_COST = 0;

/** Default max turns per run (0 = no limit). */
export const DEFAULT_MAX_TURNS = 0;
