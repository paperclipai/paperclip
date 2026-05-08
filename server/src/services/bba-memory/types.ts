/**
 * BBA Memory — TypeScript types matching schema.sql.
 *
 * These types are the public contract between the SQLite layer and the rest
 * of the BBA flow (keepalive, training scripts, UI). Keep them aligned with
 * the schema; if you add a column, add it here too.
 */

export type RunSource =
  | "keepalive"
  | "login-script"
  | "relogin-simple"
  | "probe"
  | "selector-doctor"
  | "training"
  | "manual";

export type RunOutcome = "success" | "failure" | "partial";

export type SessionStatus = "active" | "expired" | "unknown";

export type TrainingMode = "back-to-back" | "spaced";

export type TrainingStatus = "running" | "completed" | "aborted";

export type SelectorPurpose =
  | "overlay"
  | "login-button"
  | "login-modal"
  | "username-input"
  | "password-input"
  | "submit-login"
  | "session-active"
  | "session-expired"
  | "captcha-detected";

export type SelectorSource = "seeded" | "discovered" | "reviewed";

export type PopupAction =
  | "dismissed"
  | "click-failed"
  | "detected-only"
  | "ignored";

export type PopupOutcome = "closed" | "still-visible" | "unknown";

export type ReviewStatus = "pending" | "approved" | "rejected";

export type FailureClass =
  | "CAPTCHA_VISIBLE"
  | "OTP_REQUIRED"
  | "WRONG_CREDS"
  | "RATE_LIMITED"
  | "SELECTOR_NOT_FOUND"
  | "SELECTOR_STALE"
  | "NAVIGATION_TIMEOUT"
  | "NETWORK_ERROR"
  | "UNEXPECTED_POPUP"
  | "SESSION_NOT_DETECTED"
  | "BROWSER_CRASH"
  | "UNKNOWN";

export type FailureStep =
  | "cookie-load"
  | "navigate"
  | "dismiss-overlay"
  | "click-conectare"
  | "fill-username"
  | "fill-password"
  | "submit"
  | "verify-session"
  | "trace-start"
  | "trace-stop"
  | "other";

// ---------------------------------------------------------------------------
// Row types (what the DB returns)
// ---------------------------------------------------------------------------

export interface TrainingSessionRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  mode: TrainingMode;
  planned_runs: number;
  completed_runs: number;
  successful_runs: number;
  status: TrainingStatus;
  notes: string | null;
}

export interface RunRow {
  id: number;
  training_session_id: number | null;
  started_at: string;
  finished_at: string | null;
  source: RunSource;
  trigger: string | null;
  outcome: RunOutcome | null;
  failure_class: FailureClass | null;
  session_status_before: SessionStatus | null;
  session_status_after: SessionStatus | null;
  cookie_count_before: number | null;
  cookie_count_after: number | null;
  duration_ms: number | null;
  trace_zip_path: string | null;
  final_screenshot_path: string | null;
  notes: string | null;
  meta_json: string | null;
}

export interface SelectorRow {
  id: number;
  purpose: SelectorPurpose;
  selector: string;
  selector_label: string | null;
  priority: number;
  hit_count: number;
  miss_count: number;
  click_success_count: number;
  click_fail_count: number;
  first_seen_at: string;
  last_seen_at: string;
  last_success_at: string | null;
  last_fail_at: string | null;
  enabled: number; // SQLite stores boolean as 0/1
  source: SelectorSource;
  notes: string | null;
}

export interface PopupRow {
  id: number;
  run_id: number;
  seen_at: string;
  selector_id: number | null;
  selector_text: string;
  matched_visible_text: string | null;
  action: PopupAction;
  outcome: PopupOutcome | null;
  url_path: string | null;
  screenshot_path: string | null;
  is_new: number;
  review_status: ReviewStatus | null;
  reviewed_at: string | null;
}

export interface FailureRow {
  id: number;
  run_id: number;
  occurred_at: string;
  failure_class: FailureClass;
  step: FailureStep | string | null;
  selector_attempted: string | null;
  error_message: string | null;
  screenshot_path: string | null;
  url: string | null;
  console_tail: string | null;
  network_status: string | null;
  meta_json: string | null;
}

// ---------------------------------------------------------------------------
// Aggregate / projection types (what callers usually want)
// ---------------------------------------------------------------------------

export interface SuccessStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  partialRuns: number;
  successRatePct: number; // 0-100
  avgDurationMs: number | null;
  failureBreakdown: Array<{ failureClass: FailureClass; count: number }>;
  windowDays: number;
}

export interface SelectorRanked extends SelectorRow {
  // computed: hit_count - miss_count, used for display ordering when desired
  net_hits: number;
}
