/**
 * Quota-aware run pacing.
 *
 * Local subscription agents (`claude_local`, `codex_local`) share rolling
 * usage windows: a short session window and a weekly window. Pacing lowers
 * each paced agent's concurrent-run limit when usage runs ahead of an even
 * spend rate, so the fleet does not burn a whole window early. Pacing only
 * limits new run starts; it never cancels a running run.
 */

/** Effective pacing mode for one provider. */
export const QUOTA_PACING_MODES = ["full", "half", "low"] as const;
export type QuotaPacingMode = (typeof QUOTA_PACING_MODES)[number];

/** Configured mode: "auto" follows the quota windows; the others are manual overrides. */
export const QUOTA_PACING_MODE_SETTINGS = ["auto", ...QUOTA_PACING_MODES] as const;
export type QuotaPacingModeSetting = (typeof QUOTA_PACING_MODE_SETTINGS)[number];

/** Providers whose local adapters are paced. */
export const QUOTA_PACING_PROVIDERS = ["anthropic", "openai"] as const;
export type QuotaPacingProvider = (typeof QUOTA_PACING_PROVIDERS)[number];

/**
 * Polling faster than this gets rate limited by the provider usage endpoints
 * (see https://github.com/paperclipai/paperclip/issues/14096).
 */
export const QUOTA_PACING_MIN_POLL_INTERVAL_SEC = 300;
export const QUOTA_PACING_MAX_POLL_INTERVAL_SEC = 3600;
export const QUOTA_PACING_MAX_SESSION_RESERVE_PERCENT = 60;
export const QUOTA_PACING_MAX_WEEKLY_ALLOWANCE_PERCENT = 30;

export interface QuotaPacingSettings {
  /** Off by default: with pacing off the scheduler behaves exactly as before. */
  enabled: boolean;
  mode: QuotaPacingModeSetting;
  /** Share of the session window kept free for interactive use of the same subscription. */
  sessionReservePercent: number;
  /** How far weekly usage may run ahead of an even weekly spend rate. */
  weeklyAllowancePercent: number;
  /** Seconds between quota polls while pacing is on. */
  pollIntervalSec: number;
}

export const DEFAULT_QUOTA_PACING_SETTINGS: QuotaPacingSettings = {
  enabled: false,
  mode: "auto",
  sessionReservePercent: 20,
  weeklyAllowancePercent: 8,
  pollIntervalSec: QUOTA_PACING_MIN_POLL_INTERVAL_SEC,
};

/** Why a provider runs at its current mode. */
export type QuotaPacingReason =
  | "disabled"
  | "manual_override"
  | "no_data"
  | "stale_data"
  | "session_limit"
  | "weekly_limit"
  | "session_ahead"
  | "weekly_ahead"
  | "on_pace";

/** Usage against pace for one quota window. Percent values are 0-100. */
export interface QuotaPacingWindowState {
  usedPercent: number;
  /** Usage an even spend rate allows at this point of the window; null when the window position is unknown. */
  targetPercent: number | null;
  /** usedPercent minus targetPercent; positive means ahead of pace. */
  aheadPercent: number | null;
  /** Share of the window that has elapsed. */
  elapsedPercent: number | null;
  resetsAt: string | null;
  windowSeconds: number | null;
}

export interface QuotaPacingProviderState {
  provider: QuotaPacingProvider;
  mode: QuotaPacingMode;
  reason: QuotaPacingReason;
  session: QuotaPacingWindowState | null;
  weekly: QuotaPacingWindowState | null;
  /** When the last successful quota data for this provider arrived. */
  lastPolledAt: string | null;
  /** Error from the latest poll for this provider; null when it succeeded. */
  lastError: string | null;
}

/** Response of `GET /companies/:companyId/costs/quota-pacing`. */
export interface QuotaPacingState {
  enabled: boolean;
  settings: QuotaPacingSettings;
  /** When the latest poll attempt finished. */
  lastPolledAt: string | null;
  nextPollAt: string | null;
  /** Error from the latest poll attempt as a whole; null when it succeeded. */
  lastError: string | null;
  providers: QuotaPacingProviderState[];
}
