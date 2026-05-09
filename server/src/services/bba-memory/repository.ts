/**
 * BBA Memory — repository layer.
 *
 * All read/write operations go through here. Callers (keepalive, training
 * scripts, UI routes) never touch SQL directly.
 *
 * Conventions:
 *   - All times are ISO 8601 strings.
 *   - Booleans are stored as 0/1; we expose them as numbers in row types.
 *   - Counter increments are upsert-style (INSERT OR IGNORE then UPDATE).
 *   - Functions throw on programmer errors (bad enum, missing FK).
 */
import { getDb } from "./db.js";
import type {
  FailureClass,
  FailureRow,
  FailureStep,
  PopupAction,
  PopupOutcome,
  PopupRow,
  ReviewStatus,
  RunOutcome,
  RunRow,
  RunSource,
  SelectorPurpose,
  SelectorRanked,
  SelectorRow,
  SessionStatus,
  SuccessStats,
  TrainingMode,
  TrainingSessionRow,
  TrainingStatus,
} from "./types.js";

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Training sessions
// ---------------------------------------------------------------------------

export function startTrainingSession(input: {
  mode: TrainingMode;
  plannedRuns: number;
  notes?: string;
}): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO training_sessions (started_at, mode, planned_runs, notes)
       VALUES (?, ?, ?, ?)`,
    )
    .run(nowIso(), input.mode, input.plannedRuns, input.notes ?? null);
  return Number(result.lastInsertRowid);
}

export function completeTrainingSession(
  id: number,
  status: TrainingStatus = "completed",
): void {
  const db = getDb();

  // Recompute counters from runs table for accuracy.
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS ok
       FROM runs WHERE training_session_id = ?`,
    )
    .get(id) as { total: number; ok: number };

  db.prepare(
    `UPDATE training_sessions
     SET completed_at = ?, status = ?,
         completed_runs = ?, successful_runs = ?
     WHERE id = ?`,
  ).run(nowIso(), status, counts.total ?? 0, counts.ok ?? 0, id);
}

export function getTrainingSession(id: number): TrainingSessionRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM training_sessions WHERE id = ?`)
      .get(id) as TrainingSessionRow | undefined) ?? null
  );
}

export function listTrainingSessions(limit = 50): TrainingSessionRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM training_sessions
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as TrainingSessionRow[];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function startRun(input: {
  trainingSessionId?: number;
  source: RunSource;
  trigger?: string;
  sessionStatusBefore?: SessionStatus;
  cookieCountBefore?: number;
}): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO runs (
         training_session_id, started_at, source, trigger,
         session_status_before, cookie_count_before
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.trainingSessionId ?? null,
      nowIso(),
      input.source,
      input.trigger ?? null,
      input.sessionStatusBefore ?? null,
      input.cookieCountBefore ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function completeRun(
  runId: number,
  input: {
    outcome: RunOutcome;
    failureClass?: FailureClass;
    sessionStatusAfter?: SessionStatus;
    cookieCountAfter?: number;
    durationMs?: number;
    traceZipPath?: string;
    finalScreenshotPath?: string;
    notes?: string;
    meta?: Record<string, unknown>;
  },
): void {
  const db = getDb();
  db.prepare(
    `UPDATE runs SET
       finished_at = ?,
       outcome = ?,
       failure_class = ?,
       session_status_after = ?,
       cookie_count_after = ?,
       duration_ms = ?,
       trace_zip_path = ?,
       final_screenshot_path = ?,
       notes = ?,
       meta_json = ?
     WHERE id = ?`,
  ).run(
    nowIso(),
    input.outcome,
    input.failureClass ?? null,
    input.sessionStatusAfter ?? null,
    input.cookieCountAfter ?? null,
    input.durationMs ?? null,
    input.traceZipPath ?? null,
    input.finalScreenshotPath ?? null,
    input.notes ?? null,
    input.meta ? JSON.stringify(input.meta) : null,
    runId,
  );
}

export function getRun(id: number): RunRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM runs WHERE id = ?`)
      .get(id) as RunRow | undefined) ?? null
  );
}

export function listRecentRuns(limit = 100): RunRow[] {
  return getDb()
    .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as unknown as RunRow[];
}

export function listRunsForSession(sessionId: number): RunRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM runs WHERE training_session_id = ?
       ORDER BY started_at ASC`,
    )
    .all(sessionId) as unknown as RunRow[];
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Returns selectors for a given purpose, ordered for trial.
 * Default ordering: priority ASC (lower = first), then net hits DESC.
 * Disabled selectors are omitted.
 */
export function getSelectorsByPurpose(
  purpose: SelectorPurpose,
): SelectorRanked[] {
  const rows = getDb()
    .prepare(
      `SELECT *,
         (hit_count - miss_count) AS net_hits
       FROM selectors_observed
       WHERE purpose = ? AND enabled = 1
       ORDER BY priority ASC, net_hits DESC, id ASC`,
    )
    .all(purpose) as unknown as SelectorRanked[];
  return rows;
}

export function listAllSelectors(): SelectorRanked[] {
  return getDb()
    .prepare(
      `SELECT *,
         (hit_count - miss_count) AS net_hits
       FROM selectors_observed
       ORDER BY purpose ASC, priority ASC, id ASC`,
    )
    .all() as unknown as SelectorRanked[];
}

/**
 * Idempotent upsert: if (purpose, selector) doesn't exist, create it as
 * `discovered`. Then bump the requested counters.
 */
export function recordSelectorObservation(input: {
  purpose: SelectorPurpose;
  selector: string;
  hit?: boolean;
  miss?: boolean;
  clickSuccess?: boolean;
  clickFail?: boolean;
  selectorLabel?: string;
}): { selectorId: number; isNew: boolean } {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM selectors_observed WHERE purpose = ? AND selector = ?`,
    )
    .get(input.purpose, input.selector) as { id: number } | undefined;

  let selectorId: number;
  let isNew = false;

  if (!existing) {
    const result = db
      .prepare(
        `INSERT INTO selectors_observed (
           purpose, selector, selector_label, priority,
           first_seen_at, last_seen_at, source
         ) VALUES (?, ?, ?, 100, ?, ?, 'discovered')`,
      )
      .run(
        input.purpose,
        input.selector,
        input.selectorLabel ?? null,
        nowIso(),
        nowIso(),
      );
    selectorId = Number(result.lastInsertRowid);
    isNew = true;
  } else {
    selectorId = existing.id;
  }

  const sets: string[] = [`last_seen_at = ?`];
  const args: (string | number)[] = [nowIso()];

  if (input.hit) {
    sets.push(`hit_count = hit_count + 1`);
  }
  if (input.miss) {
    sets.push(`miss_count = miss_count + 1`);
  }
  if (input.clickSuccess) {
    sets.push(`click_success_count = click_success_count + 1`);
    sets.push(`last_success_at = ?`);
    args.push(nowIso());
  }
  if (input.clickFail) {
    sets.push(`click_fail_count = click_fail_count + 1`);
    sets.push(`last_fail_at = ?`);
    args.push(nowIso());
  }

  args.push(selectorId);
  db.prepare(
    `UPDATE selectors_observed SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...args);

  return { selectorId, isNew };
}

export function setSelectorEnabled(id: number, enabled: boolean): void {
  getDb()
    .prepare(`UPDATE selectors_observed SET enabled = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, id);
}

export function setSelectorPriority(id: number, priority: number): void {
  getDb()
    .prepare(`UPDATE selectors_observed SET priority = ? WHERE id = ?`)
    .run(priority, id);
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------

export function recordPopup(input: {
  runId: number;
  selector: string;
  matchedVisibleText?: string;
  action: PopupAction;
  outcome?: PopupOutcome;
  urlPath?: string;
  screenshotPath?: string;
  purpose?: SelectorPurpose; // defaults to 'overlay'
}): { popupId: number; isNew: boolean } {
  const db = getDb();
  const purpose = input.purpose ?? "overlay";

  // Upsert selector and grab id + isNew.
  const obs = recordSelectorObservation({
    purpose,
    selector: input.selector,
    hit: input.action === "dismissed" || input.action === "click-failed" || input.action === "detected-only",
    clickSuccess: input.action === "dismissed" && input.outcome === "closed",
    clickFail: input.action === "click-failed",
  });

  const result = db
    .prepare(
      `INSERT INTO popups_seen (
         run_id, seen_at, selector_id, selector_text,
         matched_visible_text, action, outcome, url_path,
         screenshot_path, is_new, review_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      nowIso(),
      obs.selectorId,
      input.selector,
      input.matchedVisibleText ?? null,
      input.action,
      input.outcome ?? null,
      input.urlPath ?? null,
      input.screenshotPath ?? null,
      obs.isNew ? 1 : 0,
      obs.isNew ? "pending" : null,
    );

  return { popupId: Number(result.lastInsertRowid), isNew: obs.isNew };
}

export function getPopupReviewQueue(): PopupRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM popups_seen
       WHERE is_new = 1 AND review_status = 'pending'
       ORDER BY seen_at DESC`,
    )
    .all() as unknown as PopupRow[];
}

export function listPopupsForRun(runId: number): PopupRow[] {
  return getDb()
    .prepare(`SELECT * FROM popups_seen WHERE run_id = ? ORDER BY seen_at ASC`)
    .all(runId) as unknown as PopupRow[];
}

/**
 * Approve or reject a queued popup. On approval, the linked selector
 * is marked source='reviewed' so it's distinguishable from raw discoveries.
 * On rejection, the selector is disabled (won't be tried automatically).
 */
export function reviewPopup(
  popupId: number,
  status: ReviewStatus,
): void {
  const db = getDb();
  const popup = db
    .prepare(`SELECT * FROM popups_seen WHERE id = ?`)
    .get(popupId) as PopupRow | undefined;
  if (!popup) throw new Error(`popup ${popupId} not found`);

  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE popups_seen SET review_status = ?, reviewed_at = ? WHERE id = ?`,
    ).run(status, nowIso(), popupId);

    if (popup.selector_id) {
      if (status === "approved") {
        db.prepare(
          `UPDATE selectors_observed SET source = 'reviewed', enabled = 1 WHERE id = ?`,
        ).run(popup.selector_id);
      } else if (status === "rejected") {
        db.prepare(
          `UPDATE selectors_observed SET enabled = 0 WHERE id = ?`,
        ).run(popup.selector_id);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export function recordFailure(input: {
  runId: number;
  failureClass: FailureClass;
  step?: FailureStep | string;
  selectorAttempted?: string;
  errorMessage?: string;
  screenshotPath?: string;
  url?: string;
  consoleTail?: string;
  networkStatus?: string;
  meta?: Record<string, unknown>;
}): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO failures (
         run_id, occurred_at, failure_class, step,
         selector_attempted, error_message, screenshot_path,
         url, console_tail, network_status, meta_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      nowIso(),
      input.failureClass,
      input.step ?? null,
      input.selectorAttempted ?? null,
      input.errorMessage ?? null,
      input.screenshotPath ?? null,
      input.url ?? null,
      input.consoleTail ?? null,
      input.networkStatus ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
    );
  return Number(result.lastInsertRowid);
}

export function listFailuresForRun(runId: number): FailureRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM failures WHERE run_id = ? ORDER BY occurred_at ASC`,
    )
    .all(runId) as unknown as FailureRow[];
}

// ---------------------------------------------------------------------------
// Stats / aggregations
// ---------------------------------------------------------------------------

export function getSuccessStats(windowDays = 7): SuccessStats {
  const db = getDb();
  const since = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS ok,
         SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS bad,
         SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partial,
         AVG(duration_ms) AS avg_dur
       FROM runs WHERE started_at >= ?`,
    )
    .get(since) as {
      total: number;
      ok: number;
      bad: number;
      partial: number;
      avg_dur: number | null;
    };

  const breakdown = db
    .prepare(
      `SELECT failure_class AS failureClass, COUNT(*) AS count
       FROM runs
       WHERE started_at >= ? AND failure_class IS NOT NULL
       GROUP BY failure_class
       ORDER BY count DESC`,
    )
    .all(since) as Array<{ failureClass: FailureClass; count: number }>;

  const total = totals.total ?? 0;
  return {
    totalRuns: total,
    successfulRuns: totals.ok ?? 0,
    failedRuns: totals.bad ?? 0,
    partialRuns: totals.partial ?? 0,
    successRatePct:
      total > 0 ? Math.round(((totals.ok ?? 0) / total) * 1000) / 10 : 0,
    avgDurationMs: totals.avg_dur ?? null,
    failureBreakdown: breakdown,
    windowDays,
  };
}
