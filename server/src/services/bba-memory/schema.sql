-- BBA Memory schema v1
-- Local SQLite journal for BBA login flow: training runs, popups seen,
-- selector observations, and structured failures. Used to teach BBA which
-- selectors and popup-handling strategies actually work over time.
--
-- Location: ~/.paperclip/bba-memory/bba-memory.db
-- Retention: runs/popups/failures auto-pruned after 30 days.
--           training_sessions and selectors_observed are kept forever.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- Tracks schema migrations so we can evolve safely.
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- A grouping of related runs (e.g. "3 back-to-back logins" or "3 spaced logins").
CREATE TABLE IF NOT EXISTS training_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,                              -- ISO 8601
  completed_at TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('back-to-back', 'spaced')),
  planned_runs INTEGER NOT NULL,
  completed_runs INTEGER NOT NULL DEFAULT 0,
  successful_runs INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'aborted')),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_training_sessions_started_at
  ON training_sessions(started_at DESC);

-- Every BBA flow execution: keepalive checks, manual logins, training runs, probes.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  training_session_id INTEGER,                           -- NULL for non-training runs
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source TEXT NOT NULL
    CHECK (source IN ('keepalive', 'login-script', 'relogin-simple',
                      'probe', 'selector-doctor', 'training', 'manual')),
  trigger TEXT,                                          -- e.g. 'auto-30min', 'session-expired', 'training-1-of-3'
  outcome TEXT
    CHECK (outcome IS NULL OR outcome IN ('success', 'failure', 'partial')),
  failure_class TEXT,                                    -- see failure_class enum docs
  session_status_before TEXT
    CHECK (session_status_before IS NULL OR session_status_before IN ('active', 'expired', 'unknown')),
  session_status_after TEXT
    CHECK (session_status_after IS NULL OR session_status_after IN ('active', 'expired', 'unknown')),
  cookie_count_before INTEGER,
  cookie_count_after INTEGER,
  duration_ms INTEGER,
  trace_zip_path TEXT,                                   -- Playwright trace .zip
  final_screenshot_path TEXT,
  notes TEXT,
  meta_json TEXT,                                        -- arbitrary structured extras
  FOREIGN KEY (training_session_id) REFERENCES training_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_started_at  ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_outcome     ON runs(outcome);
CREATE INDEX IF NOT EXISTS idx_runs_training    ON runs(training_session_id);
CREATE INDEX IF NOT EXISTS idx_runs_source      ON runs(source);

-- One row per (purpose, selector). Updated incrementally with hit/miss counters.
-- This is what BBA reads at decision time to choose which selector to try first.
--
-- purpose enum:
--   overlay              - popup/banner/modal close button
--   login-button         - header CONECTARE that opens login modal
--   login-modal          - the login modal container
--   username-input       - username field in login modal
--   password-input       - password field in login modal
--   submit-login         - the login submit button
--   session-active       - element that signals user is logged in
--   session-expired      - element that signals user is logged out
--   captcha-detected     - element that signals CAPTCHA presence
CREATE TABLE IF NOT EXISTS selectors_observed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  selector TEXT NOT NULL,
  selector_label TEXT,                                   -- friendly name for UI
  priority INTEGER NOT NULL DEFAULT 100,                 -- lower = try first
  hit_count INTEGER NOT NULL DEFAULT 0,                  -- found visible
  miss_count INTEGER NOT NULL DEFAULT 0,                 -- looked, not visible
  click_success_count INTEGER NOT NULL DEFAULT 0,
  click_fail_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_success_at TEXT,
  last_fail_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'discovered'
    CHECK (source IN ('seeded', 'discovered', 'reviewed')),
  notes TEXT,
  UNIQUE (purpose, selector)
);

CREATE INDEX IF NOT EXISTS idx_selectors_purpose
  ON selectors_observed(purpose, enabled, priority);

-- Each popup/overlay encountered during a run.
CREATE TABLE IF NOT EXISTS popups_seen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  selector_id INTEGER,                                   -- if matched a known selector
  selector_text TEXT NOT NULL,                           -- raw selector that matched (in case selector_id is NULL)
  matched_visible_text TEXT,                             -- inner text of element (max ~200 chars)
  action TEXT NOT NULL
    CHECK (action IN ('dismissed', 'click-failed', 'detected-only', 'ignored')),
  outcome TEXT
    CHECK (outcome IS NULL OR outcome IN ('closed', 'still-visible', 'unknown')),
  url_path TEXT,
  screenshot_path TEXT,
  is_new INTEGER NOT NULL DEFAULT 0,                     -- 1 = was not in catalog at detection
  review_status TEXT
    CHECK (review_status IS NULL OR review_status IN ('pending', 'approved', 'rejected')),
  reviewed_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (selector_id) REFERENCES selectors_observed(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_popups_run     ON popups_seen(run_id);
CREATE INDEX IF NOT EXISTS idx_popups_review  ON popups_seen(review_status, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_popups_new     ON popups_seen(is_new, review_status);

-- Detailed structured record of every failure event during a run.
-- failure_class enum:
--   CAPTCHA_VISIBLE       - reCAPTCHA / hCaptcha / challenge UI detected
--   OTP_REQUIRED          - 2FA / OTP screen
--   WRONG_CREDS           - explicit "wrong password" feedback
--   RATE_LIMITED          - "too many attempts" / 429 / temp lockout
--   SELECTOR_NOT_FOUND    - expected element didn't appear
--   SELECTOR_STALE        - element found but click/fill failed
--   NAVIGATION_TIMEOUT    - page didn't load in time
--   NETWORK_ERROR         - DNS / SSL / connection refused
--   UNEXPECTED_POPUP      - popup blocking action, no dismiss matched
--   SESSION_NOT_DETECTED  - login appeared OK but verification failed
--   BROWSER_CRASH         - Chromium process died
--   UNKNOWN               - fallback
CREATE TABLE IF NOT EXISTS failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  step TEXT,                                             -- e.g. 'cookie-load', 'navigate', 'dismiss-overlay', 'click-conectare', 'fill-username', 'submit', 'verify-session'
  selector_attempted TEXT,
  error_message TEXT,
  screenshot_path TEXT,
  url TEXT,
  console_tail TEXT,                                     -- last few console messages from page (truncated)
  network_status TEXT,                                   -- last meaningful response code / status text
  meta_json TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_failures_class    ON failures(failure_class, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_failures_run      ON failures(run_id);

-- Server-side idempotency store for POST /betting-browser-automation/execute.
-- TTL = 60s. GC is lazy: stale rows deleted on read. No cron needed.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,               -- UUID v4, max 128 chars
  company_id TEXT NOT NULL,
  response_json TEXT NOT NULL,               -- serialised ExecuteBetResponse
  created_at TEXT NOT NULL                   -- ISO 8601 timestamp
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_keys(created_at);
