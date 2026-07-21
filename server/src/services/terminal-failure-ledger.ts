/**
 * Terminal control-plane failure ledger (fail-closed escalation).
 *
 * When a worker cannot self-report a terminal failure (e.g. process_lost),
 * this module creates a visible issue-comment record ("원장") on the issue
 * that was running at the time, and enforces idempotency via a dedupe key so
 * that the same failure is never recorded more than once:
 *
 *   dedupeKey = agentId + rootRunId + normalizedFailureCause
 *
 * On re-delivery of the same event the existing comment is stamped with an
 * updated `redeliveryCount` in its metadata; no new top-level comment is
 * created.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { issueComments } from "@paperclipai/db";
import type { IssueCommentMetadata } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

// The issueComments.metadata column is typed as IssueCommentMetadata | null in
// the schema. We store our own structured payload there, which extends the
// standard shape minimally. We cast via unknown to avoid fighting the schema
// type while keeping our data readable in the column.
type TerminalFailureMeta = {
  version: 1;
  sections: [];
  terminalFailureDedupeKey: string;
  agentId: string;
  runId: string;
  rootRunId: string;
  normalizedFailureCause: string;
  redeliveryCount: number;
  recordedAt: string;
  lastRedeliveredAt?: string;
};

export interface TerminalFailureInput {
  companyId: string;
  agentId: string;
  issueId: string;
  runId: string;
  /** The canonical root run id (set to runId when no parent run exists). */
  rootRunId: string;
  failureCause: string;
}

export interface TerminalFailureLedgerResult {
  kind: "created" | "deduplicated";
  commentId: string;
  dedupeKey: string;
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
 * Record (or deduplicate) a terminal control-plane failure for an issue.
 *
 * Returns the existing comment id when the dedupe key already exists, or the
 * newly-created comment id when this is the first occurrence.
 */
export async function recordTerminalFailure(
  db: Db,
  input: TerminalFailureInput,
): Promise<TerminalFailureLedgerResult> {
  const dedupeKey = buildDedupeKey(input.agentId, input.rootRunId, input.failureCause);
  const normalizedCause = normalizeFailureCause(input.failureCause);

  // Check for an existing ledger comment with this dedupe key.
  const existing = await db
    .select({ id: issueComments.id, metadata: issueComments.metadata })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorType, "system"),
        sql`${issueComments.metadata} ->> 'terminalFailureDedupeKey' = ${dedupeKey}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing) {
    // Deduplicated re-delivery: increment redelivery counter in metadata.
    const prevMeta = (existing.metadata ?? {}) as Record<string, unknown>;
    const redeliveryCount = (typeof prevMeta.redeliveryCount === "number" ? prevMeta.redeliveryCount : 0) + 1;
    const updatedMeta: TerminalFailureMeta = {
      ...(prevMeta as TerminalFailureMeta),
      redeliveryCount,
      lastRedeliveredAt: new Date().toISOString(),
    };
    await db
      .update(issueComments)
      .set({
        metadata: updatedMeta as unknown as IssueCommentMetadata,
        updatedAt: new Date(),
      })
      .where(eq(issueComments.id, existing.id));

    logger.info(
      { commentId: existing.id, dedupeKey, redeliveryCount },
      "terminal-failure-ledger: deduplicated re-delivery, existing comment updated",
    );
    return { kind: "deduplicated", commentId: existing.id, dedupeKey };
  }

  // First occurrence: create the ledger comment.
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
    `| Dedupe key | \`${dedupeKey}\` |`,
    ``,
    `This failure was recorded by the Paperclip control plane because the worker ` +
    `could not self-report (e.g. \`process_lost\`). Re-delivery of the same event ` +
    `will update this comment's redelivery count without creating a duplicate.`,
  ].join("\n");

  const newMeta: TerminalFailureMeta = {
    version: 1,
    sections: [],
    terminalFailureDedupeKey: dedupeKey,
    agentId: input.agentId,
    runId: input.runId,
    rootRunId: input.rootRunId,
    normalizedFailureCause: normalizedCause,
    redeliveryCount: 0,
    recordedAt: new Date().toISOString(),
  };
  await db.insert(issueComments).values({
    id: commentId,
    companyId: input.companyId,
    issueId: input.issueId,
    authorType: "system",
    body,
    metadata: newMeta as unknown as IssueCommentMetadata,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  logger.info(
    { commentId, dedupeKey, failureCause: input.failureCause },
    "terminal-failure-ledger: created new ledger entry",
  );
  return { kind: "created", commentId, dedupeKey };
}
