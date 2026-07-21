/**
 * Terminal control-plane failure ledger (fail-closed escalation).
 *
 * When a worker cannot self-report a terminal failure (e.g. `process_lost`),
 * the control plane records it here so it is never silently dropped. The record
 * is durable and reachable whether or not the failed run carried issue context:
 *
 *   - A row in the dedicated `terminal_failure_ledger` table (the durable
 *     "원장"), keyed by a DB unique index on (companyId, dedupeKey).
 *   - A top-level internal report issue ("top-level 내부 보고"), created once per
 *     ledger row via an injected `createReportIssue` callback. This is the
 *     durable, always-reachable surface — with or without issue context — and it
 *     names the source issue (when any) in its body. It is deliberately the ONLY
 *     visible surface: no in-context issue comment is emitted, so escalation does
 *     not perturb the source issue's own recovery/blocking thread.
 *
 * Idempotency is atomic and race-safe. The dedupe key is
 *
 *   dedupeKey = agentId | canonicalRootRunId | normalizedFailureCause
 *
 * and the first delivery wins the unique-index INSERT while every concurrent or
 * later re-delivery lands on ON CONFLICT DO UPDATE (bumping `redeliveryCount`).
 * Only the atomic INSERT winner creates the report/comment, so the same failure
 * — and an entire retry lineage sharing one canonical root — yields exactly one
 * ledger row, one top-level report, and zero duplicates.
 */

import type { Db } from "@paperclipai/db";
import { terminalFailureLedger } from "@paperclipai/db";
import { eq, isNull, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

/**
 * Creates the top-level internal report issue for a terminal failure and
 * returns its id. Injected by the caller so this module stays decoupled from
 * the issue service (and so tests can supply a fake). The report MUST be
 * unassigned and non-waking — it is a durable record, not an assignment.
 */
export type CreateTerminalFailureReportIssue = (input: {
  companyId: string;
  agentId: string;
  issueId: string | null;
  runId: string;
  rootRunId: string;
  failureCause: string;
  dedupeKey: string;
}) => Promise<{ issueId: string }>;

export interface TerminalFailureInput {
  companyId: string;
  agentId: string;
  /** Issue context of the failed run, or null for a generic (issue-less) run. */
  issueId: string | null;
  runId: string;
  /** The canonical root run id of the retry lineage (stable across retries). */
  rootRunId: string;
  failureCause: string;
  createReportIssue?: CreateTerminalFailureReportIssue;
}

export interface TerminalFailureLedgerResult {
  kind: "created" | "deduplicated";
  ledgerId: string;
  dedupeKey: string;
  reportIssueId: string | null;
  ledgerCommentId: string | null;
  redeliveryCount: number;
}

/**
 * Normalize a failure cause string into a stable, case-insensitive token
 * suitable for use in a dedupe key. Whitespace and punctuation are collapsed.
 */
export function normalizeFailureCause(cause: string): string {
  return cause
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildDedupeKey(
  agentId: string,
  rootRunId: string,
  failureCause: string,
): string {
  return `${agentId}|${rootRunId}|${normalizeFailureCause(failureCause)}`;
}

/** The report context reconstructable from a persisted ledger row. */
interface TerminalFailureReconcileContext {
  companyId: string;
  agentId: string;
  issueId: string | null;
  runId: string;
  rootRunId: string;
  failureCause: string;
  dedupeKey: string;
}

/**
 * Complete the durable side effect (top-level report + persisted pointer) for a
 * single ledger row, atomically and idempotently.
 *
 * Serializes on the ledger row: concurrent callers block on the FOR UPDATE lock,
 * so at most one proceeds to create the report while the rest observe the
 * persisted pointer and skip. The report create is itself idempotency-keyed by
 * the caller, so even a crash between "report created" and "pointer persisted"
 * recovers to the SAME report — never a duplicate. Re-running once the pointer is
 * present is a no-op.
 */
async function reconcileReportIssue(
  db: Db,
  ledgerId: string,
  ctx: TerminalFailureReconcileContext,
  createReportIssue: CreateTerminalFailureReportIssue,
): Promise<{ reportIssueId: string | null }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ reportIssueId: terminalFailureLedger.reportIssueId })
      .from(terminalFailureLedger)
      .where(eq(terminalFailureLedger.id, ledgerId))
      .for("update");

    let reportIssueId = locked?.reportIssueId ?? null;

    if (!reportIssueId) {
      const report = await createReportIssue({
        companyId: ctx.companyId,
        agentId: ctx.agentId,
        issueId: ctx.issueId,
        runId: ctx.runId,
        rootRunId: ctx.rootRunId,
        failureCause: ctx.failureCause,
        dedupeKey: ctx.dedupeKey,
      });
      reportIssueId = report.issueId;
      await tx
        .update(terminalFailureLedger)
        .set({ reportIssueId })
        .where(eq(terminalFailureLedger.id, ledgerId));
    }

    return { reportIssueId };
  });
}

/**
 * Record (or deduplicate) a terminal control-plane failure.
 *
 * The insert/dedupe decision is made atomically by the DB unique index, so two
 * concurrent re-deliveries of the same failure can never both create a report.
 */
export async function recordTerminalFailure(
  db: Db,
  input: TerminalFailureInput,
): Promise<TerminalFailureLedgerResult> {
  const dedupeKey = buildDedupeKey(input.agentId, input.rootRunId, input.failureCause);
  const normalizedCause = normalizeFailureCause(input.failureCause);
  const now = new Date();

  // Atomic upsert. The unique index on (company_id, dedupe_key) elects a single
  // winner: a fresh INSERT returns `xmax = 0` (true); a re-delivery hits ON
  // CONFLICT DO UPDATE and returns `xmax != 0` (false). Everything downstream
  // keys off `inserted` so side effects fire exactly once.
  const [row] = await db
    .insert(terminalFailureLedger)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      dedupeKey,
      normalizedFailureCause: normalizedCause,
      failureCause: input.failureCause,
      rootRunId: input.rootRunId,
      runId: input.runId,
      issueId: input.issueId,
      redeliveryCount: 0,
      recordedAt: now,
    })
    .onConflictDoUpdate({
      target: [terminalFailureLedger.companyId, terminalFailureLedger.dedupeKey],
      set: {
        redeliveryCount: sql`${terminalFailureLedger.redeliveryCount} + 1`,
        lastRedeliveredAt: now,
        runId: input.runId,
        failureCause: input.failureCause,
      },
    })
    .returning({
      id: terminalFailureLedger.id,
      inserted: sql<boolean>`(xmax = 0)`,
      reportIssueId: terminalFailureLedger.reportIssueId,
      ledgerCommentId: terminalFailureLedger.ledgerCommentId,
      redeliveryCount: terminalFailureLedger.redeliveryCount,
    });

  // Reconcile the durable side effect (the top-level report issue).
  //
  // This runs for the INSERT winner AND for any re-delivery whose earlier
  // attempt crashed or errored partway — e.g. the report create threw, or the
  // process died after creating the report but before persisting the pointer.
  // Because the atomic upsert returns immediately on conflict, a null pointer
  // would otherwise be permanent; reconciling on every delivery (until the
  // report is present) is what makes fail-closed visibility exactly-once AND
  // crash-recoverable.
  //
  // Nothing to reconcile when the report is already present (or was never
  // requested).
  const reportOutstanding = input.createReportIssue != null && row.reportIssueId == null;

  if (!row.inserted && !reportOutstanding) {
    logger.info(
      { ledgerId: row.id, dedupeKey, redeliveryCount: row.redeliveryCount },
      "terminal-failure-ledger: deduplicated re-delivery (fully reconciled), no new report",
    );
    return {
      kind: "deduplicated",
      ledgerId: row.id,
      dedupeKey,
      reportIssueId: row.reportIssueId,
      ledgerCommentId: row.ledgerCommentId,
      redeliveryCount: row.redeliveryCount,
    };
  }

  // Serialize reconciliation on the ledger row (shared with the durable sweep).
  const reconciled = input.createReportIssue
    ? await reconcileReportIssue(
        db,
        row.id,
        {
          companyId: input.companyId,
          agentId: input.agentId,
          issueId: input.issueId,
          runId: input.runId,
          rootRunId: input.rootRunId,
          failureCause: input.failureCause,
          dedupeKey,
        },
        input.createReportIssue,
      )
    : { reportIssueId: row.reportIssueId };

  logger.info(
    {
      ledgerId: row.id,
      dedupeKey,
      reportIssueId: reconciled.reportIssueId,
      inserted: row.inserted,
      failureCause: input.failureCause,
    },
    row.inserted
      ? "terminal-failure-ledger: created new ledger entry"
      : "terminal-failure-ledger: reconciled incomplete re-delivery",
  );

  return {
    kind: row.inserted ? "created" : "deduplicated",
    ledgerId: row.id,
    dedupeKey,
    reportIssueId: reconciled.reportIssueId,
    ledgerCommentId: null,
    redeliveryCount: row.redeliveryCount,
  };
}

export interface ReconcileOutstandingReportsResult {
  scanned: number;
  reconciled: number;
  failed: number;
}

/**
 * Durable live recovery for stranded ledger rows.
 *
 * A ledger row's insert commits atomically, but the top-level report is a
 * separate side effect. If that report create (or its pointer write) fails after
 * the row commits, the row is left with a NULL `reportIssueId` — a fail-closed
 * failure that was recorded but never surfaced. The recording caller
 * (`reapOrphanedRuns`) swallows the error and moves on, and the original run has
 * already left `running`, so nothing re-delivers it: without this sweep, the
 * pointer would be permanently null and the "exactly once visible" guarantee
 * would be broken.
 *
 * This sweep is that live re-delivery trigger. It re-reconciles every row with a
 * NULL pointer, completing the report + pointer atomically per row. It is safe to
 * run repeatedly: `createReportIssue` is idempotency-keyed on the dedupe key, so a
 * row whose report already exists (but whose pointer was lost) recovers to the
 * SAME report with no duplicate, and a fully-reconciled row is never revisited
 * (the NULL filter excludes it). Meant to be driven from the periodic maintenance
 * loop.
 */
export async function reconcileOutstandingTerminalFailureReports(
  db: Db,
  createReportIssue: CreateTerminalFailureReportIssue,
  opts?: { limit?: number },
): Promise<ReconcileOutstandingReportsResult> {
  const limit = opts?.limit ?? 200;

  const rows = await db
    .select({
      id: terminalFailureLedger.id,
      companyId: terminalFailureLedger.companyId,
      agentId: terminalFailureLedger.agentId,
      issueId: terminalFailureLedger.issueId,
      runId: terminalFailureLedger.runId,
      rootRunId: terminalFailureLedger.rootRunId,
      failureCause: terminalFailureLedger.failureCause,
      dedupeKey: terminalFailureLedger.dedupeKey,
    })
    .from(terminalFailureLedger)
    .where(isNull(terminalFailureLedger.reportIssueId))
    .limit(limit);

  let reconciled = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const { reportIssueId } = await reconcileReportIssue(
        db,
        row.id,
        {
          companyId: row.companyId,
          agentId: row.agentId,
          issueId: row.issueId,
          runId: row.runId,
          rootRunId: row.rootRunId,
          failureCause: row.failureCause,
          dedupeKey: row.dedupeKey,
        },
        createReportIssue,
      );
      if (reportIssueId) reconciled += 1;
    } catch (err) {
      // Leave the row NULL so the next sweep retries it (fail-closed, never dropped).
      failed += 1;
      logger.warn(
        { err, ledgerId: row.id, dedupeKey: row.dedupeKey },
        "terminal-failure-ledger: outstanding-report reconcile failed; will retry next sweep",
      );
    }
  }

  if (reconciled > 0 || failed > 0) {
    logger.warn(
      { scanned: rows.length, reconciled, failed },
      "terminal-failure-ledger: reconciled outstanding fail-closed reports",
    );
  }

  return { scanned: rows.length, reconciled, failed };
}
