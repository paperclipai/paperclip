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
import { eq, sql } from "drizzle-orm";
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

  // Serialize reconciliation on the ledger row. Concurrent re-deliveries block
  // on this FOR UPDATE lock, so at most one proceeds to create the report while
  // the rest observe the persisted pointer and skip. The report create is
  // additionally guarded by its own idempotencyKey (see caller), so even a crash
  // between "report created" and "pointer persisted" recovers to the same report
  // — never a duplicate.
  const reconciled = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ reportIssueId: terminalFailureLedger.reportIssueId })
      .from(terminalFailureLedger)
      .where(eq(terminalFailureLedger.id, row.id))
      .for("update");

    let reportIssueId = locked?.reportIssueId ?? null;

    if (input.createReportIssue && !reportIssueId) {
      const report = await input.createReportIssue({
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
        runId: input.runId,
        rootRunId: input.rootRunId,
        failureCause: input.failureCause,
        dedupeKey,
      });
      reportIssueId = report.issueId;
      await tx
        .update(terminalFailureLedger)
        .set({ reportIssueId })
        .where(eq(terminalFailureLedger.id, row.id));
    }

    return { reportIssueId };
  });

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
