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
 *     durable surface for issue-less generic timer runs.
 *   - When the failed run had issue context, an additional system comment on
 *     that issue (the in-context 원장 comment).
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

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { issueComments, terminalFailureLedger } from "@paperclipai/db";
import type { IssueCommentMetadata } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

type TerminalFailureCommentMeta = {
  version: 1;
  sections: [];
  terminalFailureDedupeKey: string;
  agentId: string;
  runId: string;
  rootRunId: string;
  normalizedFailureCause: string;
  recordedAt: string;
};

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

  if (!row.inserted) {
    logger.info(
      { ledgerId: row.id, dedupeKey, redeliveryCount: row.redeliveryCount },
      "terminal-failure-ledger: deduplicated re-delivery (atomic upsert), no new report",
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

  // First occurrence (this transaction won the insert). Create the durable
  // top-level report and, when there is issue context, the in-context comment.
  let reportIssueId: string | null = null;
  if (input.createReportIssue) {
    try {
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
    } catch (err) {
      logger.error(
        { err, ledgerId: row.id, dedupeKey },
        "terminal-failure-ledger: failed to create top-level report issue",
      );
    }
  }

  let ledgerCommentId: string | null = null;
  if (input.issueId) {
    ledgerCommentId = await insertLedgerComment(db, {
      companyId: input.companyId,
      issueId: input.issueId,
      agentId: input.agentId,
      runId: input.runId,
      rootRunId: input.rootRunId,
      failureCause: input.failureCause,
      normalizedCause,
      dedupeKey,
      reportIssueId,
      recordedAt: now,
    });
  }

  await db
    .update(terminalFailureLedger)
    .set({ reportIssueId, ledgerCommentId })
    .where(eq(terminalFailureLedger.id, row.id));

  logger.info(
    { ledgerId: row.id, dedupeKey, reportIssueId, ledgerCommentId, failureCause: input.failureCause },
    "terminal-failure-ledger: created new ledger entry",
  );
  return {
    kind: "created",
    ledgerId: row.id,
    dedupeKey,
    reportIssueId,
    ledgerCommentId,
    redeliveryCount: 0,
  };
}

async function insertLedgerComment(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    runId: string;
    rootRunId: string;
    failureCause: string;
    normalizedCause: string;
    dedupeKey: string;
    reportIssueId: string | null;
    recordedAt: Date;
  },
): Promise<string> {
  const commentId = randomUUID();
  const body = [
    `**[Fail-closed] Terminal control-plane failure recorded**`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Failure cause | \`${input.failureCause}\` |`,
    `| Run ID | \`${input.runId}\` |`,
    `| Root run ID | \`${input.rootRunId}\` |`,
    `| Agent ID | \`${input.agentId}\` |`,
    `| Dedupe key | \`${input.dedupeKey}\` |`,
    input.reportIssueId ? `| Top-level report | \`${input.reportIssueId}\` |` : ``,
    ``,
    `This failure was recorded by the Paperclip control plane because the worker ` +
      `could not self-report (e.g. \`process_lost\`). Re-delivery of the same event ` +
      `is deduplicated by the terminal-failure ledger and will not create a duplicate.`,
  ]
    .filter((line) => line !== ``)
    .join("\n");

  const meta: TerminalFailureCommentMeta = {
    version: 1,
    sections: [],
    terminalFailureDedupeKey: input.dedupeKey,
    agentId: input.agentId,
    runId: input.runId,
    rootRunId: input.rootRunId,
    normalizedFailureCause: input.normalizedCause,
    recordedAt: input.recordedAt.toISOString(),
  };

  await db.insert(issueComments).values({
    id: commentId,
    companyId: input.companyId,
    issueId: input.issueId,
    authorType: "system",
    body,
    metadata: meta as unknown as IssueCommentMetadata,
    createdAt: input.recordedAt,
    updatedAt: input.recordedAt,
  });

  return commentId;
}
